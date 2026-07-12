import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import type {
  InitiateMediaUploadInput,
  MediaAlbumView,
  MediaArchiveScope,
  MediaAssetView,
  MediaKind,
  MediaLibraryView,
  MediaProcessingStatus,
  MediaUploadSessionView,
  MediaUploadSource,
  ShareMediaAssetInput,
  VirusScanStatus
} from "@hahatalk/contracts";
import type { Request } from "express";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";
import { ConversationService } from "../modules/conversation.service.js";
import type { ObjectRange, StoredObject } from "./local-object-store.js";
import { MediaInspector, type MediaInspection } from "./media-inspector.js";
import { type ObjectStore, objectStoreToken } from "./object-store.js";

const maxUploadBytes = 100 * 1024 * 1024;
const guestMaxUploadBytes = 25 * 1024 * 1024;
const partSizeBytes = 4 * 1024 * 1024;
const uploadLifetimeMs = 24 * 60 * 60 * 1000;

type UploadRow = {
  client_upload_id: string;
  completed_asset_id: string | null;
  declared_mime_type: string;
  expected_sha256_hex: string | null;
  expected_size_bytes: string;
  expires_at: Date;
  id: string;
  original_file_name: string;
  owner_id: string;
  part_count: number;
  part_size_bytes: number;
  source: MediaUploadSource;
  status: MediaUploadSessionView["status"];
};

export type AssetAccessRow = {
  archive_scope: MediaArchiveScope;
  can_download: boolean;
  can_preview: boolean;
  captured_at: Date | null;
  captured_local_at: Date | null;
  captured_local_text: string | null;
  captured_timezone: string | null;
  created_at: Date;
  deleted_at: Date | null;
  detected_mime_type: string;
  id: string;
  media_kind: MediaKind;
  original_file_name: string;
  original_object_key: string;
  owner_id: string;
  owner_public_id: string;
  place_name: string | null;
  preview_mime_type: string | null;
  preview_object_key: string | null;
  preview_status: MediaAssetView["previewStatus"];
  processing_status: MediaProcessingStatus;
  sha256_hex: string;
  size_bytes: string;
  source: MediaUploadSource;
  virus_scan_status: VirusScanStatus;
};

type UploadPartRow = {
  object_key: string;
  part_number: number;
  sha256_hex: string;
  size_bytes: number;
};

type LibraryCursor = { createdAt: string; id: string };

function encodeCursor(row: { created_at: Date; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at.toISOString(), id: row.id })).toString("base64url");
}

function decodeCursor(value?: string): LibraryCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as LibraryCursor;
    if (!/^[0-9a-f-]{36}$/i.test(parsed.id) || Number.isNaN(new Date(parsed.createdAt).getTime())) throw new Error();
    return parsed;
  } catch {
    throw new BadRequestException("Media cursor is invalid.");
  }
}

function normalizedFileName(value: string) {
  const normalized = value.normalize("NFC").replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  if (!normalized || normalized.length > 255 || /[\u0000-\u001f]/.test(normalized)) {
    throw new BadRequestException("File name is invalid.");
  }
  return normalized;
}

function publicContentUrl(assetId: string, variant: "preview" | "original", download = false) {
  return `/media/assets/${assetId}/content?variant=${variant}${download ? "&download=1" : ""}`;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(objectStoreToken) private readonly objects: ObjectStore,
    private readonly inspector: MediaInspector,
    private readonly conversations: ConversationService
  ) {}

  async initiateUpload(principal: AuthPrincipal, input: InitiateMediaUploadInput): Promise<MediaUploadSessionView> {
    if (!principal.state.permissions.canUploadFiles) {
      throw new ForbiddenException("File upload permission is required.");
    }
    const limit = principal.state.role === "guest" ? guestMaxUploadBytes : maxUploadBytes;
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > limit) {
      throw new BadRequestException(`File size must be between 1 byte and ${Math.round(limit / 1024 / 1024)} MB.`);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/.test(input.clientUploadId)) {
      throw new BadRequestException("Client upload id is invalid.");
    }
    const sha256Hex = input.sha256Hex?.toLowerCase();
    if (sha256Hex && !/^[0-9a-f]{64}$/.test(sha256Hex)) {
      throw new BadRequestException("Expected SHA-256 is invalid.");
    }
    const fileName = normalizedFileName(input.fileName);
    const mimeType = input.declaredMimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
    if (!mimeType || mimeType.length > 160) throw new BadRequestException("Declared MIME type is invalid.");
    const partCount = Math.ceil(input.sizeBytes / partSizeBytes);
    const expiresAt = new Date(Date.now() + uploadLifetimeMs);

    const id = await this.database.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into media_upload_sessions (
           organization_id, owner_id, client_upload_id, original_file_name, declared_mime_type,
           expected_size_bytes, expected_sha256_hex, part_size_bytes, part_count, source,
           status, expires_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'initiated', $11)
         on conflict (owner_id, client_upload_id) do nothing
         returning id`,
        [
          principal.state.user.organizationId,
          principal.internalUserId,
          input.clientUploadId,
          fileName,
          mimeType,
          input.sizeBytes,
          sha256Hex ?? null,
          partSizeBytes,
          partCount,
          input.source,
          expiresAt
        ]
      );
      if (inserted.rows[0]) {
        await this.audit(client, principal, "media.upload.initiated", "media_upload", inserted.rows[0].id, {
          partCount: String(partCount),
          sizeBytes: String(input.sizeBytes),
          source: input.source
        });
        return inserted.rows[0].id;
      }
      const existing = await client.query<UploadRow>(
        "select * from media_upload_sessions where owner_id = $1 and client_upload_id = $2",
        [principal.internalUserId, input.clientUploadId]
      );
      const row = existing.rows[0];
      if (!row) throw new ConflictException("Upload id conflict could not be resolved.");
      if (
        row.original_file_name !== fileName
        || row.declared_mime_type !== mimeType
        || Number(row.expected_size_bytes) !== input.sizeBytes
        || row.expected_sha256_hex !== (sha256Hex ?? null)
        || row.source !== input.source
      ) {
        throw new ConflictException("Client upload id was already used for a different file.");
      }
      return row.id;
    });
    return this.uploadView(principal, id);
  }

  async uploadView(principal: AuthPrincipal, uploadId: string): Promise<MediaUploadSessionView> {
    const result = await this.database.query<UploadRow>(
      "select * from media_upload_sessions where id = $1 and owner_id = $2",
      [uploadId, principal.internalUserId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Upload session was not found.");
    const parts = await this.database.query<{ part_number: number }>(
      "select part_number from media_upload_parts where upload_id = $1 order by part_number",
      [uploadId]
    );
    return {
      id: row.id,
      clientUploadId: row.client_upload_id,
      declaredMimeType: row.declared_mime_type,
      expiresAt: row.expires_at.toISOString(),
      fileName: row.original_file_name,
      partCount: row.part_count,
      partSizeBytes: row.part_size_bytes,
      sizeBytes: Number(row.expected_size_bytes),
      status: row.status,
      uploadedPartNumbers: parts.rows.map((part) => part.part_number),
      ...(row.completed_asset_id ? { asset: await this.getAsset(principal, row.completed_asset_id) } : {})
    };
  }

  async uploadPart(
    principal: AuthPrincipal,
    uploadId: string,
    partNumber: number,
    request: Request,
    expectedPartSha256?: string
  ) {
    const sessionResult = await this.database.query<UploadRow>(
      "select * from media_upload_sessions where id = $1 and owner_id = $2",
      [uploadId, principal.internalUserId]
    );
    const session = sessionResult.rows[0];
    if (!session) throw new NotFoundException("Upload session was not found.");
    if (!["initiated", "uploading"].includes(session.status)) {
      throw new ConflictException("Upload session no longer accepts parts.");
    }
    if (session.expires_at.getTime() <= Date.now()) {
      await this.database.query("update media_upload_sessions set status = 'expired', updated_at = now() where id = $1", [uploadId]);
      throw new GoneException("Upload session expired.");
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.part_count) {
      throw new BadRequestException("Part number is outside this upload session.");
    }
    const totalSize = Number(session.expected_size_bytes);
    const expectedSize = partNumber === session.part_count
      ? totalSize - session.part_size_bytes * (session.part_count - 1)
      : session.part_size_bytes;
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (contentLength && contentLength !== expectedSize) {
      throw new BadRequestException("Part byte count does not match the upload plan.");
    }
    const normalizedPartHash = expectedPartSha256?.toLowerCase();
    if (normalizedPartHash && !/^[0-9a-f]{64}$/.test(normalizedPartHash)) {
      throw new BadRequestException("Part SHA-256 is invalid.");
    }
    const objectKey = `uploads/${principal.internalUserId}/${uploadId}/parts/${String(partNumber).padStart(5, "0")}`;
    let stored: StoredObject;
    try {
      stored = await this.objects.writeStream(objectKey, request, expectedSize);
      if (stored.sizeBytes !== expectedSize) throw new BadRequestException("Uploaded part is incomplete.");
      if (normalizedPartHash && normalizedPartHash !== stored.sha256Hex) {
        throw new BadRequestException("Part SHA-256 does not match its content.");
      }
      await this.database.transaction(async (client) => {
        const locked = await client.query<UploadRow>(
          "select * from media_upload_sessions where id = $1 and owner_id = $2 for update",
          [uploadId, principal.internalUserId]
        );
        if (!locked.rows[0] || !["initiated", "uploading"].includes(locked.rows[0].status)) {
          throw new ConflictException("Upload session changed while the part was being written.");
        }
        await client.query(
          `insert into media_upload_parts (upload_id, part_number, object_key, size_bytes, sha256_hex)
           values ($1, $2, $3, $4, $5)
           on conflict (upload_id, part_number) do update
           set object_key = excluded.object_key, size_bytes = excluded.size_bytes,
               sha256_hex = excluded.sha256_hex, uploaded_at = now()`,
          [uploadId, partNumber, objectKey, stored.sizeBytes, stored.sha256Hex]
        );
        await client.query("update media_upload_sessions set status = 'uploading', updated_at = now() where id = $1", [uploadId]);
      });
      return { partNumber, sha256Hex: stored.sha256Hex, sizeBytes: stored.sizeBytes };
    } catch (error) {
      await this.objects.remove(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async completeUpload(principal: AuthPrincipal, uploadId: string, finalSha256Hex?: string) {
    const normalizedFinalHash = finalSha256Hex?.toLowerCase();
    if (normalizedFinalHash && !/^[0-9a-f]{64}$/.test(normalizedFinalHash)) {
      throw new BadRequestException("Final SHA-256 is invalid.");
    }
    let finalObjectKey: string | undefined;
    let variantObjectKey: string | undefined;
    let assetId: string;
    try {
      assetId = await this.database.transaction(async (client) => {
        const uploadResult = await client.query<UploadRow>(
          "select * from media_upload_sessions where id = $1 and owner_id = $2 for update",
          [uploadId, principal.internalUserId]
        );
        const upload = uploadResult.rows[0];
        if (!upload) throw new NotFoundException("Upload session was not found.");
        if (upload.status === "completed" && upload.completed_asset_id) return upload.completed_asset_id;
        if (!["initiated", "uploading", "completing"].includes(upload.status)) {
          throw new ConflictException("Upload session cannot be completed.");
        }
        if (upload.expires_at.getTime() <= Date.now()) {
          await client.query("update media_upload_sessions set status = 'expired', updated_at = now() where id = $1", [uploadId]);
          throw new GoneException("Upload session expired.");
        }
        const parts = await client.query<UploadPartRow>(
          "select * from media_upload_parts where upload_id = $1 order by part_number",
          [uploadId]
        );
        if (parts.rows.length !== upload.part_count || parts.rows.some((part, index) => part.part_number !== index + 1)) {
          throw new ConflictException("Every upload part must be present before completion.");
        }
        const expectedSize = Number(upload.expected_size_bytes);
        if (parts.rows.reduce((sum, part) => sum + part.size_bytes, 0) !== expectedSize) {
          throw new ConflictException("Uploaded part sizes do not match the declared file size.");
        }
        await client.query("update media_upload_sessions set status = 'completing', updated_at = now() where id = $1", [uploadId]);

        const assembledKey = `uploads/${principal.internalUserId}/${uploadId}/assembled`;
        let assembled: StoredObject;
        try {
          assembled = await this.objects.assemble(parts.rows.map((part) => part.object_key), assembledKey, expectedSize);
        } catch {
          throw new ConflictException("An uploaded part is unavailable and must be uploaded again.");
        }
        await this.objects.fsync(assembledKey);
        const expectedHash = normalizedFinalHash ?? upload.expected_sha256_hex;
        const integrityBlocked = assembled.sizeBytes !== expectedSize || Boolean(expectedHash && expectedHash !== assembled.sha256Hex);
        const inspection = integrityBlocked
          ? this.blockedInspection("integrity_mismatch")
          : await this.inspector.inspect(assembledKey, upload.original_file_name, upload.declared_mime_type);
        const blocked = Boolean(inspection.blockedCode);
        const nextAssetId = randomUUID();
        finalObjectKey = `${blocked ? "quarantine" : "objects"}/${principal.state.user.organizationId}/${principal.internalUserId}/${nextAssetId}/original`;
        await this.objects.move(assembledKey, finalObjectKey);

        let variant;
        if (!blocked && inspection.mediaKind === "image") {
          const stripped = this.inspector.createGpsStrippedImage(
            await this.objects.readBuffer(finalObjectKey),
            inspection.detectedMimeType
          );
          if (stripped) {
            variantObjectKey = `objects/${principal.state.user.organizationId}/${principal.internalUserId}/${nextAssetId}/shared-preview`;
            variant = await this.objects.putBuffer(variantObjectKey, stripped);
          }
        }

        const processingStatus: MediaProcessingStatus = blocked
          ? inspection.scanSummary === "failed" ? "failed" : "blocked"
          : "ready";
        const virusScanStatus: VirusScanStatus = blocked
          ? inspection.scanSummary === "failed" ? "failed" : "blocked"
          : "clean";
        const previewStatus: MediaAssetView["previewStatus"] = blocked
          ? "failed"
          : inspection.mediaKind === "image"
            ? variant ? "ready" : "unavailable"
            : ["pdf", "video", "audio", "text"].includes(inspection.mediaKind) ? "ready" : "unavailable";

        await client.query(
          `insert into media_assets (
             id, organization_id, owner_id, original_object_key, original_file_name,
             declared_mime_type, detected_mime_type, media_kind, size_bytes, sha256_hex,
             processing_status, preview_status, virus_scan_status, scan_engine, scan_summary,
             source, captured_at, captured_local_at, captured_timezone, latitude, longitude,
             width, height, private_metadata_json
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb
           )`,
          [
            nextAssetId,
            principal.state.user.organizationId,
            principal.internalUserId,
            finalObjectKey,
            upload.original_file_name,
            upload.declared_mime_type,
            inspection.detectedMimeType,
            inspection.mediaKind,
            assembled.sizeBytes,
            assembled.sha256Hex,
            processingStatus,
            previewStatus,
            virusScanStatus,
            inspection.scanEngine,
            inspection.blockedCode ?? inspection.scanSummary,
            upload.source,
            inspection.capturedAt ?? null,
            inspection.capturedLocalAt ?? null,
            inspection.capturedTimezone ?? null,
            inspection.latitude ?? null,
            inspection.longitude ?? null,
            inspection.width ?? null,
            inspection.height ?? null,
            JSON.stringify(inspection.privateMetadata)
          ]
        );
        if (variant) {
          await client.query(
            `insert into media_variants (
               asset_id, variant_kind, object_key, mime_type, size_bytes, sha256_hex, gps_stripped
             ) values ($1, 'shared_preview', $2, $3, $4, $5, true)`,
            [nextAssetId, variant.objectKey, inspection.detectedMimeType, variant.sizeBytes, variant.sha256Hex]
          );
        }
        for (const [stage, status, code] of [
          ["assemble", "succeeded", null],
          ["integrity", integrityBlocked ? "blocked" : "succeeded", integrityBlocked ? "integrity_mismatch" : null],
          ["mime", inspection.blockedCode === "mime_mismatch" ? "blocked" : "succeeded", inspection.blockedCode === "mime_mismatch" ? inspection.blockedCode : null],
          ["malware", blocked ? "blocked" : "succeeded", inspection.blockedCode ?? null],
          ["metadata", blocked ? "failed" : "succeeded", null],
          ["variant", variant || inspection.mediaKind !== "image" ? "succeeded" : "failed", null],
          ["complete", blocked ? "blocked" : "succeeded", inspection.blockedCode ?? null]
        ] as const) {
          await client.query(
            "insert into media_processing_events (upload_id, asset_id, stage, status, code) values ($1, $2, $3, $4, $5)",
            [uploadId, nextAssetId, stage, status, code]
          );
        }
        await client.query(
          `update media_upload_sessions
           set status = 'completed', completed_asset_id = $2, completed_at = now(), updated_at = now(),
               failure_code = $3
           where id = $1`,
          [uploadId, nextAssetId, inspection.blockedCode ?? null]
        );
        await this.audit(client, principal, "media.upload.completed", "media_asset", nextAssetId, {
          result: processingStatus,
          sizeBytes: String(assembled.sizeBytes),
          source: upload.source
        });
        return nextAssetId;
      });
    } catch (error) {
      if (finalObjectKey) await this.objects.remove(finalObjectKey).catch(() => undefined);
      if (variantObjectKey) await this.objects.remove(variantObjectKey).catch(() => undefined);
      throw error;
    }
    await this.objects.removePrefix(`uploads/${principal.internalUserId}/${uploadId}`).catch(() => undefined);
    return this.getAsset(principal, assetId);
  }

  async abortUpload(principal: AuthPrincipal, uploadId: string) {
    const result = await this.database.transaction(async (client) => {
      const upload = await client.query<UploadRow>(
        "select * from media_upload_sessions where id = $1 and owner_id = $2 for update",
        [uploadId, principal.internalUserId]
      );
      const row = upload.rows[0];
      if (!row) throw new NotFoundException("Upload session was not found.");
      if (row.status === "completed") throw new ConflictException("Completed uploads cannot be aborted.");
      await client.query("update media_upload_sessions set status = 'aborted', updated_at = now() where id = $1", [uploadId]);
      await this.audit(client, principal, "media.upload.aborted", "media_upload", uploadId, {});
      return { ok: true };
    });
    await this.objects.removePrefix(`uploads/${principal.internalUserId}/${uploadId}`).catch(() => undefined);
    return result;
  }

  async getAsset(principal: AuthPrincipal, assetId: string): Promise<MediaAssetView> {
    const row = await this.assetAccess(principal, assetId);
    return this.assetView(row, row.owner_id === principal.internalUserId);
  }

  async listLibrary(
    principal: AuthPrincipal,
    options: { before?: string; date?: string; limit?: number; place?: string; scope?: MediaArchiveScope }
  ): Promise<MediaLibraryView> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 40));
    const cursor = decodeCursor(options.before);
    if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
      throw new BadRequestException("Media date filter is invalid.");
    }
    if (options.place && options.place.length > 120) throw new BadRequestException("Place filter is too long.");
    const values: unknown[] = [principal.internalUserId];
    const where = ["a.owner_id = $1", "a.deleted_at is null"];
    if (options.scope) {
      values.push(options.scope);
      where.push(`a.archive_scope = $${values.length}`);
    }
    if (options.date) {
      values.push(options.date);
      where.push(`coalesce(a.captured_local_at::date, (a.captured_at at time zone 'UTC')::date, a.created_at::date) = $${values.length}::date`);
    }
    if (options.place) {
      values.push(`%${options.place.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
      where.push(`a.place_name ilike $${values.length} escape '\\'`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where.push(`(a.created_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const result = await this.database.query<AssetAccessRow>(
      `select a.*, owner.public_id as owner_public_id,
              to_char(a.captured_local_at, 'YYYY-MM-DD"T"HH24:MI:SS') as captured_local_text,
              true as can_download, true as can_preview,
              variant.object_key as preview_object_key, variant.mime_type as preview_mime_type
       from media_assets a
       join users owner on owner.id = a.owner_id
       left join media_variants variant on variant.asset_id = a.id and variant.variant_kind = 'shared_preview'
       where ${where.join(" and ")}
       order by a.created_at desc, a.id desc
       limit $${values.length}`,
      values
    );
    const rows = result.rows.slice(0, limit);
    const albums = await this.listAlbums(principal);
    return {
      albums,
      assets: rows.map((row) => this.assetView(row, true)),
      hasMore: result.rows.length > limit,
      ...(result.rows.length > limit && rows.at(-1) ? { nextCursor: encodeCursor(rows.at(-1)!) } : {})
    };
  }

  shareAsset(principal: AuthPrincipal, assetId: string, input: ShareMediaAssetInput) {
    return this.conversations.sendMediaMessage(principal, assetId, input);
  }

  revokeShare(principal: AuthPrincipal, assetId: string, messageId: string) {
    return this.conversations.revokeMediaShare(principal, assetId, messageId);
  }

  async updateAssetMetadata(principal: AuthPrincipal, assetId: string, placeName?: string, capturedLocalAt?: string) {
    const normalizedPlace = placeName?.trim() || null;
    if (normalizedPlace && normalizedPlace.length > 120) throw new BadRequestException("Place name is too long.");
    if (capturedLocalAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(capturedLocalAt)) {
      throw new BadRequestException("Local capture time is invalid.");
    }
    await this.database.transaction(async (client) => {
      const changed = await client.query(
        `update media_assets set place_name = $3, captured_local_at = coalesce($4::timestamp, captured_local_at), updated_at = now()
         where id = $1 and owner_id = $2 and deleted_at is null returning id`,
        [assetId, principal.internalUserId, normalizedPlace, capturedLocalAt ?? null]
      );
      if (!changed.rowCount) throw new NotFoundException("Owned media asset was not found.");
      await this.audit(client, principal, "media.metadata.updated", "media_asset", assetId, {
        capturedTimeChanged: String(Boolean(capturedLocalAt)),
        placeChanged: String(placeName !== undefined)
      });
    });
    return this.getAsset(principal, assetId);
  }

  async createAlbum(principal: AuthPrincipal, name: string, description = "") {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 80 || description.length > 500) {
      throw new BadRequestException("Album name or description is invalid.");
    }
    const result = await this.database.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `insert into media_albums (organization_id, owner_id, name, description)
         values ($1, $2, $3, $4) returning id`,
        [principal.state.user.organizationId, principal.internalUserId, normalizedName, description.trim()]
      );
      const id = inserted.rows[0]!.id;
      await this.audit(client, principal, "media.album.created", "media_album", id, {});
      return id;
    });
    return (await this.listAlbums(principal)).find((album) => album.id === result)!;
  }

  async addAlbumItem(principal: AuthPrincipal, albumId: string, assetId: string) {
    await this.database.transaction(async (client) => {
      const owned = await client.query(
        `select 1 from media_albums album
         join media_assets asset on asset.id = $2 and asset.owner_id = album.owner_id and asset.deleted_at is null
         where album.id = $1 and album.owner_id = $3 and album.deleted_at is null`,
        [albumId, assetId, principal.internalUserId]
      );
      if (!owned.rowCount) throw new NotFoundException("Owned album and asset were not found.");
      await client.query(
        `insert into media_album_items (album_id, asset_id, added_by)
         values ($1, $2, $3) on conflict (album_id, asset_id) do nothing`,
        [albumId, assetId, principal.internalUserId]
      );
      await client.query("update media_albums set updated_at = now() where id = $1", [albumId]);
      await this.audit(client, principal, "media.album.item_added", "media_album", albumId, { assetId });
    });
    return (await this.listAlbums(principal)).find((album) => album.id === albumId)!;
  }

  async removeAlbumItem(principal: AuthPrincipal, albumId: string, assetId: string) {
    await this.database.transaction(async (client) => {
      const removed = await client.query(
        `delete from media_album_items item using media_albums album
         where item.album_id = album.id and item.album_id = $1 and item.asset_id = $2
           and album.owner_id = $3 returning item.album_id`,
        [albumId, assetId, principal.internalUserId]
      );
      if (!removed.rowCount) throw new NotFoundException("Album item was not found.");
      await client.query("update media_albums set updated_at = now() where id = $1", [albumId]);
      await this.audit(client, principal, "media.album.item_removed", "media_album", albumId, { assetId });
    });
    return { ok: true };
  }

  async trashAsset(principal: AuthPrincipal, assetId: string) {
    await this.conversations.revokeAllMediaShares(principal, assetId, true);
    return { ok: true };
  }

  async restoreAsset(principal: AuthPrincipal, assetId: string) {
    await this.database.transaction(async (client) => {
      const restored = await client.query(
        "update media_assets set deleted_at = null, updated_at = now() where id = $1 and owner_id = $2 returning id",
        [assetId, principal.internalUserId]
      );
      if (!restored.rowCount) throw new NotFoundException("Owned media asset was not found.");
      await this.audit(client, principal, "media.asset.restored", "media_asset", assetId, {});
    });
    return this.getAsset(principal, assetId);
  }

  async openContent(
    principal: AuthPrincipal,
    assetId: string,
    variant: "preview" | "original",
    rangeHeader: string | undefined,
    download: boolean
  ) {
    const row = await this.assetAccess(principal, assetId);
    const owner = row.owner_id === principal.internalUserId;
    if (row.processing_status !== "ready" || row.virus_scan_status !== "clean" || row.deleted_at) {
      throw new ForbiddenException("Media bytes are not available.");
    }
    if (download && !row.can_download) throw new ForbiddenException("Download permission is required.");
    if (!download && !owner && row.preview_status !== "ready") {
      throw new ForbiddenException("A safe media preview is unavailable.");
    }
    let objectKey = row.original_object_key;
    let mimeType = row.detected_mime_type;
    if (!owner && variant === "preview" && row.media_kind === "image") {
      if (!row.preview_object_key) throw new NotFoundException("A safe shared preview is unavailable.");
      objectKey = row.preview_object_key;
      mimeType = row.preview_mime_type ?? mimeType;
    } else if (!owner && variant === "original" && row.media_kind === "image" && !row.can_download) {
      throw new ForbiddenException("Original download permission is required.");
    } else if (!row.can_preview) {
      throw new ForbiddenException("Preview permission is required.");
    }
    const { sizeBytes } = await this.objects.describe(objectKey);
    const range = this.parseRange(rangeHeader, sizeBytes);
    await this.database.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, 'media_asset', $4, $5::jsonb)`,
      [
        principal.state.user.organizationId,
        principal.internalUserId,
        download ? "media.content.downloaded" : "media.content.previewed",
        assetId,
        JSON.stringify({ range: String(Boolean(range)), variant })
      ]
    );
    return {
      fileName: row.original_file_name,
      mimeType,
      range,
      sizeBytes,
      stream: this.objects.createReadStream(objectKey, range)
    };
  }

  private async assetAccess(principal: AuthPrincipal, assetId: string) {
    const result = await this.database.query<AssetAccessRow>(
      `select a.*, owner.public_id as owner_public_id,
              coalesce(access.can_preview, false) or a.owner_id = $2 as can_preview,
              coalesce(access.can_download, false) or a.owner_id = $2 as can_download,
              variant.object_key as preview_object_key, variant.mime_type as preview_mime_type,
              to_char(a.captured_local_at, 'YYYY-MM-DD"T"HH24:MI:SS') as captured_local_text
       from media_assets a
       join users owner on owner.id = a.owner_id
       left join media_variants variant on variant.asset_id = a.id and variant.variant_kind = 'shared_preview'
       left join lateral (
         select bool_or(g.can_preview) as can_preview, bool_or(g.can_download) as can_download
         from media_grants g
         join message_attachments attachment
           on attachment.message_id = g.message_id and attachment.asset_id = g.asset_id and attachment.revoked_at is null
         join message_deliveries delivery
           on delivery.message_id = g.message_id and delivery.recipient_id = $2 and delivery.revoked_at is null
         where g.asset_id = a.id and g.grantee_id = $2 and g.revoked_at is null
       ) access on true
       where a.id = $1 and a.organization_id = $3
         and (a.owner_id = $2 or coalesce(access.can_preview, false) or coalesce(access.can_download, false))`,
      [assetId, principal.internalUserId, principal.state.user.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Media asset was not found.");
    return row;
  }

  private assetView(row: AssetAccessRow, owner: boolean): MediaAssetView {
    const ready = row.processing_status === "ready" && row.virus_scan_status === "clean" && !row.deleted_at;
    const previewVariant = !owner && row.media_kind === "image" ? "preview" : "original";
    const capturedLocal = row.captured_local_text ?? undefined;
    const previewReady = owner
      ? ready && row.can_preview && ["image", "pdf", "video", "audio", "text"].includes(row.media_kind)
      : ready && row.can_preview && row.preview_status === "ready";
    return {
      archiveScope: row.archive_scope,
      canDownload: Boolean(row.can_download),
      createdAt: row.created_at.toISOString(),
      fileName: row.original_file_name,
      id: row.id,
      mediaKind: row.media_kind,
      mimeType: row.detected_mime_type,
      ownerId: row.owner_public_id,
      previewStatus: row.preview_status,
      processingStatus: row.processing_status,
      sizeBytes: Number(row.size_bytes),
      source: row.source,
      virusScanStatus: row.virus_scan_status,
      ...(owner ? { sha256Hex: row.sha256_hex } : {}),
      ...(owner && row.captured_at ? { capturedAt: row.captured_at.toISOString() } : owner && capturedLocal ? { capturedAt: capturedLocal } : {}),
      ...(owner && row.captured_timezone ? { capturedTimezone: row.captured_timezone } : {}),
      ...(owner && row.place_name ? { placeName: row.place_name } : {}),
      ...(previewReady ? { previewUrl: publicContentUrl(row.id, previewVariant) } : {}),
      ...(ready && row.can_download ? { downloadUrl: publicContentUrl(row.id, "original", true) } : {})
    };
  }

  private async listAlbums(principal: AuthPrincipal): Promise<MediaAlbumView[]> {
    const result = await this.database.query<{
      asset_ids: string[];
      created_at: Date;
      description: string;
      id: string;
      name: string;
      updated_at: Date;
    }>(
      `select album.id, album.name, album.description, album.created_at, album.updated_at,
              coalesce(array_agg(item.asset_id::text order by item.sort_order, item.added_at)
                filter (where item.asset_id is not null), '{}') as asset_ids
       from media_albums album
       left join media_album_items item on item.album_id = album.id
       where album.owner_id = $1 and album.deleted_at is null
       group by album.id
       order by album.updated_at desc, album.id desc`,
      [principal.internalUserId]
    );
    return result.rows.map((row) => ({
      assetIds: row.asset_ids,
      createdAt: row.created_at.toISOString(),
      description: row.description,
      id: row.id,
      name: row.name,
      updatedAt: row.updated_at.toISOString()
    }));
  }

  private parseRange(value: string | undefined, sizeBytes: number): ObjectRange | undefined {
    if (!value) return undefined;
    const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
    if (!match || (!match[1] && !match[2])) throw new BadRequestException("Byte range is invalid.");
    let start: number;
    let end: number;
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isInteger(suffix) || suffix < 1) throw new BadRequestException("Byte range is invalid.");
      start = Math.max(0, sizeBytes - suffix);
      end = sizeBytes - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : sizeBytes - 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= sizeBytes) {
      throw new BadRequestException("Byte range is outside the object.");
    }
    return { start, end: Math.min(end, sizeBytes - 1) };
  }

  private blockedInspection(code: string): MediaInspection {
    return {
      blockedCode: code,
      detectedMimeType: "application/octet-stream",
      mediaKind: "file",
      privateMetadata: {},
      scanEngine: "integrity-v1",
      scanSummary: "blocked"
    };
  }

  private audit(
    client: PoolClient,
    principal: AuthPrincipal,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, string>
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [principal.state.user.organizationId, principal.internalUserId, action, targetType, targetId, JSON.stringify(metadata)]
    );
  }
}
