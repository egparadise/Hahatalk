import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  buildReadReport,
  createMessageDeliveryPlan,
  demoAiJobs,
  findCharacterPreset,
  getRoomPresentationForViewer,
  projectMessageForViewer,
  type Attachment,
  type AudienceType,
  type ConversationListItem,
  type ConversationView,
  type MemberRole,
  type Message,
  type MessageAudience,
  type MessageDeleteResult,
  type MessageDelivery,
  type MvpSnapshot,
  type Organization,
  type Room,
  type RoomMember,
  type SendConversationMessageInput,
  type ShareMediaAssetInput,
  type TypingUpdate,
  type User
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";
import { defaultHubSpaceId } from "./conversation.constants.js";

const defaultPageSize = 40;
const maxPageSize = 100;

type SpaceMemberRow = {
  character_id: string | null;
  created_at: Date;
  display_name: string;
  email: string;
  internal_user_id: string;
  joined_at: Date;
  last_read_at: Date | null;
  last_read_message_id: string | null;
  last_seen_at: Date | null;
  muted_until: Date | null;
  owner_internal_id: string;
  public_id: string;
  roster_visibility: "owner_only" | "shared" | "subscriber_count_only";
  settings_json: Record<string, unknown>;
  space_created_at: Date;
  space_id: string;
  space_name: string;
  space_role: MemberRole;
  space_type: Room["type"];
  status: string;
  view_mode: RoomMember["viewMode"];
};

type SpaceContext = {
  internalByPublic: Map<string, string>;
  members: RoomMember[];
  publicByInternal: Map<string, string>;
  room: Room;
  users: User[];
};

type MessageRow = {
  body: string;
  created_at: Date;
  deleted_at: Date | null;
  delivery_mode: Message["deliveryMode"];
  edited_at: Date | null;
  id: string;
  message_type: Message["messageType"];
  metadata_json: Message["metadata"];
  parent_message_id: string | null;
  sender_id: string;
  sender_public_id: string;
  space_id: string;
};

type AudienceRow = {
  audience_type: AudienceType;
  id: string;
  message_id: string;
  target_public_id: string | null;
  target_role: MemberRole | null;
};

type DeliveryRow = {
  confirmed_at: Date | null;
  created_at: Date;
  delivered_at: Date | null;
  id: string;
  message_id: string;
  read_at: Date | null;
  recipient_public_id: string;
  revoked_at: Date | null;
  status: MessageDelivery["status"];
  thread_key: string;
};

type AttachmentRow = {
  archive_scope: Attachment["mediaVisibility"];
  asset_id: string;
  can_download: boolean;
  captured_at: Date | null;
  captured_local_at: string | null;
  captured_timezone: string | null;
  created_at: Date;
  detected_mime_type: string;
  media_kind: Attachment["mediaKind"];
  message_id: string;
  original_file_name: string;
  owner_id: string;
  owner_public_id: string;
  place_name: string | null;
  preview_object_key: string | null;
  preview_status: Attachment["previewStatus"];
  processing_status: string;
  size_bytes: string;
  source: Attachment["source"];
  virus_scan_status: Attachment["virusScanStatus"];
};

type TimelineRow = { created_at: Date; id: string };

type ShareableAssetRow = {
  archive_scope: "private_archive" | "shared" | "selected";
  detected_mime_type: string;
  id: string;
  media_kind: "image" | "video" | "audio" | "pdf" | "text" | "office" | "file";
  original_file_name: string;
  owner_id: string;
  preview_status: "queued" | "ready" | "unavailable" | "failed";
  processing_status: "processing" | "ready" | "blocked" | "failed";
  source: "file_upload" | "screen_capture";
  virus_scan_status: "pending" | "clean" | "blocked" | "failed";
};

export type OutboxEventRow = {
  aggregate_id: string;
  attempt_count: number;
  event_type: string;
  id: string;
  payload_json: { deletedAt?: string; recipientInternalId?: string };
};

type RealtimeEnvelope = {
  event: "message:created" | "message:deleted" | "message:delivery-updated" | "message:updated";
  payload: Message | MessageDeleteResult;
  publicUserId: string;
};

function toIso(value: Date | null | undefined) {
  return value?.toISOString();
}

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeCursor(row: TimelineRow) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at.toISOString(), id: row.id })).toString("base64url");
}

function decodeCursor(cursor?: string) {
  if (!cursor) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: string; id?: string };
    const createdAt = new Date(parsed.createdAt ?? "");
    if (!parsed.id || !/^[0-9a-f-]{36}$/i.test(parsed.id) || Number.isNaN(createdAt.getTime())) {
      throw new Error("invalid cursor");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException("Message cursor is invalid.");
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

@Injectable()
export class ConversationService {
  constructor(private readonly database: DatabaseService) {}

  async snapshot(principal: AuthPrincipal, requestedSpaceId?: string, before?: string, limit?: number): Promise<MvpSnapshot> {
    const spaces = await this.listSpaces(principal);
    const selectedSpaceId = requestedSpaceId
      ?? spaces.find((item) => item.room.roomId === principal.state.roomId)?.room.roomId
      ?? spaces[0]?.room.roomId;
    if (!selectedSpaceId) {
      throw new NotFoundException("No active conversation is available.");
    }
    const view = await this.conversationView(principal, selectedSpaceId, before, limit);
    const organization = await this.organization(principal.state.user.organizationId);
    const isOwner = view.room.ownerId === principal.state.user.id;
    return {
      organization,
      ...view,
      aiJobs: isOwner ? demoAiJobs : demoAiJobs.filter((job) => job.requestedBy === principal.state.user.id),
      invites: [],
      spaces
    };
  }

  async listSpaces(principal: AuthPrincipal): Promise<ConversationListItem[]> {
    return this.database.transaction(async (client) => {
      const rows = await client.query<{ id: string }>(
        `select s.id
         from conversation_spaces s
         join space_memberships sm on sm.space_id = s.id
         where sm.user_id = $1 and sm.status in ('active', 'muted')
           and s.organization_id = $2 and s.archived_at is null
         order by (s.id = $3::uuid) desc, s.updated_at desc, s.created_at asc`,
        [principal.internalUserId, principal.state.user.organizationId, defaultHubSpaceId]
      );
      const items: ConversationListItem[] = [];
      for (const row of rows.rows) {
        const context = await this.spaceContext(client, row.id, principal.state.user.organizationId);
        this.assertMembership(context, principal);
        const presentation = getRoomPresentationForViewer(
          context.room,
          context.members,
          context.users,
          principal.state.user.id
        );
        const latest = await client.query<{ body: string; created_at: Date }>(
          `select m.body, m.created_at
           from messages m
           join message_deliveries d on d.message_id = m.id
           where m.space_id = $1 and d.recipient_id = $2
             and m.deleted_at is null and d.revoked_at is null
           order by m.created_at desc, m.id desc
           limit 1`,
          [row.id, principal.internalUserId]
        );
        const unread = await client.query<{ count: number }>(
          `select count(*)::int as count
           from messages m
           join message_deliveries d on d.message_id = m.id
           where m.space_id = $1 and d.recipient_id = $2
             and m.sender_id <> $2 and m.deleted_at is null and d.revoked_at is null and d.read_at is null`,
          [row.id, principal.internalUserId]
        );
        const last = latest.rows[0];
        items.push({
          room: presentation,
          unreadCount: unread.rows[0]?.count ?? 0,
          ...(last ? {
            lastMessageAt: last.created_at.toISOString(),
            lastMessagePreview: last.body.slice(0, 80)
          } : {})
        });
      }
      return items;
    });
  }

  async conversationView(
    principal: AuthPrincipal,
    spaceId: string,
    before?: string,
    requestedLimit = defaultPageSize
  ): Promise<ConversationView> {
    const limit = Math.max(1, Math.min(maxPageSize, requestedLimit));
    const cursor = decodeCursor(before);
    return this.database.transaction(async (client) => {
      const context = await this.spaceContext(client, spaceId, principal.state.user.organizationId);
      this.assertMembership(context, principal);
      const parameters: unknown[] = [spaceId, principal.internalUserId, limit + 1];
      const cursorClause = cursor
        ? "and (m.created_at, m.id) < ($4::timestamptz, $5::uuid)"
        : "";
      if (cursor) {
        parameters.push(cursor.createdAt, cursor.id);
      }
      const timeline = await client.query<TimelineRow>(
        `select m.id, m.created_at
         from messages m
         where m.space_id = $1 and m.deleted_at is null
           and exists (
             select 1 from message_deliveries d
             where d.message_id = m.id and d.recipient_id = $2 and d.revoked_at is null
           )
           ${cursorClause}
         order by m.created_at desc, m.id desc
         limit $3`,
        parameters
      );
      const hasMore = timeline.rows.length > limit;
      const pageRows = timeline.rows.slice(0, limit);
      const messages = await this.loadMessages(client, context, pageRows.map((row) => row.id), principal.state.user.id);
      const room = getRoomPresentationForViewer(context.room, context.members, context.users, principal.state.user.id);
      const visibleIds = new Set(room.visibleMemberIds);
      const oldest = pageRows.at(-1);
      return {
        room,
        users: context.users.filter((user) => visibleIds.has(user.id)),
        roomMembers: context.members.filter((member) => visibleIds.has(member.userId)),
        messages,
        hasMore,
        ...(hasMore && oldest ? { nextCursor: encodeCursor(oldest) } : {})
      };
    });
  }

  async sendMessage(principal: AuthPrincipal, input: SendConversationMessageInput) {
    if (!isUuid(input.spaceId)) {
      throw new BadRequestException("Conversation id is invalid.");
    }
    if (input.clientMessageId.length < 8 || input.clientMessageId.length > 160) {
      throw new BadRequestException("Client message id must be between 8 and 160 characters.");
    }
    const body = input.body.trim();
    if (!body) {
      throw new BadRequestException("Message body must not be empty.");
    }
    if (body.length > 10_000) {
      throw new BadRequestException("Message body is too long.");
    }
    const normalizedTargets = [...new Set(input.targetUserIds)].sort();
    const requestHash = stableHash({
      audienceType: input.audienceType,
      body,
      parentMessageId: input.parentMessageId ?? null,
      requiresConfirmation: Boolean(input.requiresConfirmation),
      spaceId: input.spaceId,
      targetRole: input.targetRole ?? null,
      targetUserIds: normalizedTargets
    });

    const result = await this.database.transaction(async (client) => {
      const context = await this.spaceContext(client, input.spaceId, principal.state.user.organizationId);
      this.assertMembership(context, principal);
      const claimed = await client.query(
        `insert into idempotency_keys (scope, key, owner_id, request_hash, expires_at)
         values ('message.send', $1, $2, $3, now() + interval '30 days')
         on conflict do nothing
         returning key`,
        [input.clientMessageId, principal.internalUserId, requestHash]
      );
      if (!claimed.rowCount) {
        const existing = await client.query<{ request_hash: string; response_json: { messageId?: string } | null }>(
          `select request_hash, response_json from idempotency_keys
           where scope = 'message.send' and key = $1 and owner_id = $2`,
          [input.clientMessageId, principal.internalUserId]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash) {
          throw new ConflictException("Idempotency key was already used with a different message.");
        }
        if (!row.response_json?.messageId) {
          throw new ConflictException("The original message request is still being processed.");
        }
        return { messageId: row.response_json.messageId, replay: true };
      }

      if (input.parentMessageId) {
        const parent = await client.query(
          `select 1
           from messages m
           join message_deliveries d on d.message_id = m.id
           where m.id = $1 and m.space_id = $2 and m.deleted_at is null
             and d.recipient_id = $3 and d.revoked_at is null`,
          [input.parentMessageId, input.spaceId, principal.internalUserId]
        );
        if (!parent.rowCount) {
          throw new BadRequestException("Reply target is not visible in this conversation.");
        }
      }

      let plan;
      try {
        plan = createMessageDeliveryPlan(
          context.room,
          context.members,
          "pending-message",
          principal.state.user.id,
          input.audienceType,
          normalizedTargets,
          new Date().toISOString(),
          input.targetRole
        );
      } catch (error) {
        throw new ForbiddenException(error instanceof Error ? error.message : "Message delivery is not allowed.");
      }
      if (plan.normalizedAudienceType !== "all" && plan.normalizedTargetUserIds.length === 0) {
        throw new BadRequestException("At least one valid message target is required.");
      }

      const messageId = randomUUID();
      const createdAt = new Date();
      await client.query(
        `insert into messages (
           id, space_id, sender_id, client_message_id, parent_message_id,
           message_type, delivery_mode, body, metadata_json, created_at
         ) values ($1, $2, $3, $4, $5, 'text', $6, $7, $8::jsonb, $9)`,
        [
          messageId,
          input.spaceId,
          principal.internalUserId,
          input.clientMessageId,
          input.parentMessageId ?? null,
          plan.deliveryMode,
          body,
          JSON.stringify(input.requiresConfirmation ? { requiresConfirmation: true } : {}),
          createdAt
        ]
      );

      await this.insertAudience(client, context, messageId, plan.normalizedAudienceType, plan.normalizedTargetUserIds, input.targetRole);
      for (const delivery of plan.deliveries) {
        const recipientInternalId = context.internalByPublic.get(delivery.recipientId);
        if (!recipientInternalId) {
          throw new BadRequestException("A message recipient is no longer active.");
        }
        await client.query(
          `insert into message_deliveries (
             message_id, recipient_id, thread_key, status, delivered_at, read_at, created_at
           ) values ($1, $2, $3, 'delivered', $4, $5, $4)`,
          [
            messageId,
            recipientInternalId,
            delivery.threadKey,
            createdAt,
            delivery.recipientId === principal.state.user.id ? createdAt : null
          ]
        );
        await this.insertOutbox(client, messageId, recipientInternalId, "conversation.message.created");
      }
      await client.query(
        `update idempotency_keys
         set response_json = jsonb_build_object('messageId', $4::text), status_code = 201
         where scope = 'message.send' and key = $1 and owner_id = $2 and request_hash = $3`,
        [input.clientMessageId, principal.internalUserId, requestHash, messageId]
      );
      await client.query("update conversation_spaces set updated_at = $2 where id = $1", [input.spaceId, createdAt]);
      return { messageId, replay: false };
    });

    const message = await this.messageForViewer(principal, result.messageId);
    return { message, replay: result.replay };
  }

  async sendMediaMessage(principal: AuthPrincipal, assetId: string, input: ShareMediaAssetInput) {
    if (!isUuid(assetId) || !isUuid(input.spaceId)) {
      throw new BadRequestException("Media asset or conversation id is invalid.");
    }
    if (input.clientMessageId.length < 8 || input.clientMessageId.length > 160) {
      throw new BadRequestException("Client message id must be between 8 and 160 characters.");
    }
    const caption = input.caption?.trim() ?? "";
    if (caption.length > 2_000) throw new BadRequestException("Media caption is too long.");
    const normalizedTargets = [...new Set(input.targetUserIds)].sort();
    const expectedScope = input.audienceType === "all" ? "shared" : "selected";
    if (input.archiveScope !== expectedScope) {
      throw new BadRequestException("Media share scope does not match its message audience.");
    }
    const requestHash = stableHash({
      archiveScope: input.archiveScope,
      assetId,
      audienceType: input.audienceType,
      caption,
      spaceId: input.spaceId,
      targetRole: input.targetRole ?? null,
      targetUserIds: normalizedTargets
    });

    const result = await this.database.transaction(async (client) => {
      const context = await this.spaceContext(client, input.spaceId, principal.state.user.organizationId);
      this.assertMembership(context, principal);
      if (!context.room.settings.fileSharingEnabled || !principal.state.permissions.canUploadFiles) {
        throw new ForbiddenException("File sharing is disabled in this conversation.");
      }
      const assetResult = await client.query<ShareableAssetRow>(
        `select id, owner_id, original_file_name, detected_mime_type, media_kind,
                archive_scope, processing_status, preview_status, virus_scan_status, source
         from media_assets
         where id = $1 and organization_id = $2 and deleted_at is null
         for update`,
        [assetId, principal.state.user.organizationId]
      );
      const asset = assetResult.rows[0];
      if (!asset || asset.owner_id !== principal.internalUserId) {
        throw new NotFoundException("Owned media asset was not found.");
      }
      if (asset.processing_status !== "ready" || asset.virus_scan_status !== "clean") {
        throw new ConflictException("Only a clean, completed media asset can be shared.");
      }

      const claimed = await client.query(
        `insert into idempotency_keys (scope, key, owner_id, request_hash, expires_at)
         values ('media.share', $1, $2, $3, now() + interval '30 days')
         on conflict do nothing returning key`,
        [input.clientMessageId, principal.internalUserId, requestHash]
      );
      if (!claimed.rowCount) {
        const existing = await client.query<{ request_hash: string; response_json: { messageId?: string } | null }>(
          `select request_hash, response_json from idempotency_keys
           where scope = 'media.share' and key = $1 and owner_id = $2`,
          [input.clientMessageId, principal.internalUserId]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash) {
          throw new ConflictException("Idempotency key was already used for a different media share.");
        }
        if (!row.response_json?.messageId) {
          throw new ConflictException("The original media share is still being processed.");
        }
        return { messageId: row.response_json.messageId, replay: true };
      }

      let plan;
      try {
        plan = createMessageDeliveryPlan(
          context.room,
          context.members,
          "pending-media-message",
          principal.state.user.id,
          input.audienceType,
          normalizedTargets,
          new Date().toISOString(),
          input.targetRole
        );
      } catch (error) {
        throw new ForbiddenException(error instanceof Error ? error.message : "Media delivery is not allowed.");
      }
      if (plan.normalizedAudienceType !== "all" && plan.normalizedTargetUserIds.length === 0) {
        throw new BadRequestException("At least one valid media recipient is required.");
      }

      const messageId = randomUUID();
      const createdAt = new Date();
      const messageType: Message["messageType"] = ["image", "video", "audio"].includes(asset.media_kind)
        ? asset.media_kind as "image" | "video" | "audio"
        : "file";
      const body = caption || asset.original_file_name;
      await client.query(
        `insert into messages (
           id, space_id, sender_id, client_message_id, message_type, delivery_mode,
           body, metadata_json, created_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          messageId,
          input.spaceId,
          principal.internalUserId,
          input.clientMessageId,
          messageType,
          plan.deliveryMode,
          body,
          JSON.stringify({ source: asset.source, mediaVisibility: input.archiveScope }),
          createdAt
        ]
      );
      await this.insertAudience(
        client,
        context,
        messageId,
        plan.normalizedAudienceType,
        plan.normalizedTargetUserIds,
        input.targetRole
      );
      await client.query(
        `insert into message_attachments (message_id, asset_id, linked_by, caption)
         values ($1, $2, $3, $4)`,
        [messageId, assetId, principal.internalUserId, caption]
      );
      for (const delivery of plan.deliveries) {
        const recipientInternalId = context.internalByPublic.get(delivery.recipientId);
        if (!recipientInternalId) throw new BadRequestException("A media recipient is no longer active.");
        const recipientRole = context.members.find((member) => member.userId === delivery.recipientId)?.role;
        const canDownload = delivery.recipientId === principal.state.user.id
          || !["guest", "subscriber"].includes(recipientRole ?? "guest")
          || context.room.settings.guestCanDownload;
        await client.query(
          `insert into message_deliveries (
             message_id, recipient_id, thread_key, status, delivered_at, read_at, created_at
           ) values ($1, $2, $3, 'delivered', $4, $5, $4)`,
          [
            messageId,
            recipientInternalId,
            delivery.threadKey,
            createdAt,
            delivery.recipientId === principal.state.user.id ? createdAt : null
          ]
        );
        await client.query(
          `insert into media_grants (
             asset_id, message_id, grantee_id, granted_by, can_preview, can_download
           ) values ($1, $2, $3, $4, true, $5)`,
          [assetId, messageId, recipientInternalId, principal.internalUserId, canDownload]
        );
        await this.insertOutbox(client, messageId, recipientInternalId, "conversation.message.created");
      }
      await client.query(
        "update media_assets set archive_scope = $2, updated_at = now() where id = $1",
        [assetId, input.archiveScope]
      );
      await client.query(
        `update idempotency_keys
         set response_json = jsonb_build_object('messageId', $4::text), status_code = 201
         where scope = 'media.share' and key = $1 and owner_id = $2 and request_hash = $3`,
        [input.clientMessageId, principal.internalUserId, requestHash, messageId]
      );
      await client.query("update conversation_spaces set updated_at = $2 where id = $1", [input.spaceId, createdAt]);
      await client.query(
        `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
         values ($1, $2, 'media.share.created', 'media_asset', $3, $4::jsonb)`,
        [
          principal.state.user.organizationId,
          principal.internalUserId,
          assetId,
          JSON.stringify({ audienceType: plan.normalizedAudienceType, messageId, recipientCount: String(plan.deliveries.length) })
        ]
      );
      return { messageId, replay: false };
    });
    return { message: await this.messageForViewer(principal, result.messageId), replay: result.replay };
  }

  async editMessage(principal: AuthPrincipal, messageId: string, nextBody: string) {
    const body = nextBody.trim();
    if (!body || body.length > 10_000) {
      throw new BadRequestException("Edited message body is invalid.");
    }
    await this.database.transaction(async (client) => {
      const row = await this.lockedMessage(client, messageId);
      const context = await this.spaceContext(client, row.space_id, principal.state.user.organizationId);
      this.assertMembership(context, principal);
      if (row.sender_id !== principal.internalUserId) {
        throw new ForbiddenException("Only the message author can edit this message.");
      }
      if (row.deleted_at) {
        throw new ConflictException("Deleted messages cannot be edited.");
      }
      await client.query("update messages set body = $2, edited_at = now() where id = $1", [messageId, body]);
      await this.enqueueExistingRecipients(client, messageId, "conversation.message.updated");
    });
    return this.messageForViewer(principal, messageId);
  }

  async deleteMessage(principal: AuthPrincipal, messageId: string): Promise<MessageDeleteResult> {
    return this.database.transaction(async (client) => {
      const row = await this.lockedMessage(client, messageId);
      const context = await this.spaceContext(client, row.space_id, principal.state.user.organizationId);
      const membership = this.assertMembership(context, principal);
      const canModerate = context.room.ownerId === principal.state.user.id
        || (context.room.type !== "hub" && ["owner", "admin"].includes(membership.role));
      if (row.sender_id !== principal.internalUserId && !canModerate) {
        throw new ForbiddenException("Message delete permission is required.");
      }
      if (row.deleted_at) {
        return { id: messageId, deletedAt: row.deleted_at.toISOString() };
      }
      const deletedAt = new Date();
      await client.query("update messages set deleted_at = $2 where id = $1", [messageId, deletedAt]);
      await this.enqueueExistingRecipients(client, messageId, "conversation.message.deleted", { deletedAt: deletedAt.toISOString() });
      return { id: messageId, deletedAt: deletedAt.toISOString() };
    });
  }

  async revokeMediaShare(
    principal: AuthPrincipal,
    assetId: string,
    messageId: string
  ): Promise<MessageDeleteResult> {
    return this.database.transaction(async (client) => {
      await this.lockOwnedAsset(client, principal, assetId);
      const result = await this.revokeMediaMessage(client, assetId, messageId);
      const remaining = await client.query(
        "select 1 from message_attachments where asset_id = $1 and revoked_at is null limit 1",
        [assetId]
      );
      if (!remaining.rowCount) {
        await client.query(
          "update media_assets set archive_scope = 'private_archive', updated_at = now() where id = $1",
          [assetId]
        );
      }
      await client.query(
        `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
         values ($1, $2, 'media.share.revoked', 'media_asset', $3, $4::jsonb)`,
        [
          principal.state.user.organizationId,
          principal.internalUserId,
          assetId,
          JSON.stringify({ messageId })
        ]
      );
      return result;
    });
  }

  async revokeAllMediaShares(principal: AuthPrincipal, assetId: string, trash: boolean) {
    return this.database.transaction(async (client) => {
      const asset = await this.lockOwnedAsset(client, principal, assetId);
      const links = await client.query<{ message_id: string }>(
        "select message_id from message_attachments where asset_id = $1 and revoked_at is null order by created_at",
        [assetId]
      );
      for (const link of links.rows) {
        await this.revokeMediaMessage(client, assetId, link.message_id);
      }
      await client.query(
        `update media_assets
         set archive_scope = 'private_archive', deleted_at = case when $2 then coalesce(deleted_at, now()) else deleted_at end,
             updated_at = now()
         where id = $1`,
        [assetId, trash]
      );
      await client.query(
        `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
         values ($1, $2, $3, 'media_asset', $4, $5::jsonb)`,
        [
          principal.state.user.organizationId,
          principal.internalUserId,
          trash ? "media.asset.trashed" : "media.share.all_revoked",
          assetId,
          JSON.stringify({ shareCount: String(links.rows.length), wasDeleted: String(Boolean(asset.deleted_at)) })
        ]
      );
      return { ok: true };
    });
  }

  async markRead(principal: AuthPrincipal, messageId: string, confirmed: boolean) {
    await this.database.transaction(async (client) => {
      const updated = await client.query<{ sender_id: string; space_id: string }>(
        `update message_deliveries d
         set read_at = coalesce(d.read_at, now()),
             confirmed_at = case when $3::boolean then coalesce(d.confirmed_at, now()) else d.confirmed_at end
         from messages m
         where d.message_id = m.id and d.message_id = $1 and d.recipient_id = $2
           and d.revoked_at is null and m.deleted_at is null
         returning m.sender_id, m.space_id`,
        [messageId, principal.internalUserId, confirmed]
      );
      const row = updated.rows[0];
      if (!row) {
        throw new NotFoundException("Visible message delivery was not found.");
      }
      await client.query(
        `update space_memberships
         set last_read_message_id = $3, last_read_at = now()
         where space_id = $1 and user_id = $2 and status in ('active', 'muted')
           and (
             last_read_message_id is null
             or exists (
               select 1
               from messages previous_message, messages target_message
               where previous_message.id = space_memberships.last_read_message_id
                 and target_message.id = $3
                 and (previous_message.created_at, previous_message.id)
                   <= (target_message.created_at, target_message.id)
             )
           )`,
        [row.space_id, principal.internalUserId, messageId]
      );
      const recipients = new Set([principal.internalUserId, row.sender_id]);
      for (const recipientId of recipients) {
        await this.insertOutbox(client, messageId, recipientId, "conversation.message.delivery_updated");
      }
    });
    return this.messageForViewer(principal, messageId);
  }

  async readReport(principal: AuthPrincipal, messageId: string) {
    return this.database.transaction(async (client) => {
      const row = await client.query<{ sender_id: string; space_id: string }>(
        "select sender_id, space_id from messages where id = $1 and deleted_at is null",
        [messageId]
      );
      const messageRow = row.rows[0];
      if (!messageRow) {
        throw new NotFoundException("Message was not found.");
      }
      const context = await this.spaceContext(client, messageRow.space_id, principal.state.user.organizationId);
      const membership = this.assertMembership(context, principal);
      const authorized = messageRow.sender_id === principal.internalUserId
        || context.room.ownerId === principal.state.user.id
        || (context.room.type !== "hub" && ["owner", "admin"].includes(membership.role));
      if (!authorized) {
        throw new ForbiddenException("Read report permission is required.");
      }
      const messages = await this.loadMessages(client, context, [messageId], principal.state.user.id, true);
      const message = messages[0];
      if (!message) {
        throw new NotFoundException("Message was not found.");
      }
      return buildReadReport(message, context.users);
    });
  }

  async search(principal: AuthPrincipal, spaceId: string, query: string, requestedLimit = 30) {
    const needle = query.trim();
    if (needle.length < 2 || needle.length > 100) {
      throw new BadRequestException("Search text must be between 2 and 100 characters.");
    }
    const limit = Math.max(1, Math.min(50, requestedLimit));
    const escaped = needle.replace(/[\\%_]/g, (value) => `\\${value}`);
    return this.database.transaction(async (client) => {
      const context = await this.spaceContext(client, spaceId, principal.state.user.organizationId);
      this.assertMembership(context, principal);
      const result = await client.query<{ id: string }>(
        `select m.id
         from messages m
         where m.space_id = $1 and m.deleted_at is null
           and m.body ilike ('%' || $3 || '%') escape '\\'
           and exists (
             select 1 from message_deliveries d
             where d.message_id = m.id and d.recipient_id = $2 and d.revoked_at is null
           )
         order by m.created_at desc, m.id desc
         limit $4`,
        [spaceId, principal.internalUserId, escaped, limit]
      );
      return this.loadMessages(client, context, result.rows.map((row) => row.id), principal.state.user.id);
    });
  }

  async typingRecipients(principal: AuthPrincipal, spaceId: string, targetUserIds: string[] = []) {
    if (!isUuid(spaceId)) {
      throw new BadRequestException("Conversation id is invalid.");
    }
    return this.database.transaction(async (client) => {
      const context = await this.spaceContext(client, spaceId, principal.state.user.organizationId);
      this.assertMembership(context, principal);
      const actorId = principal.state.user.id;
      const validTargets = new Set(targetUserIds.filter((id) => context.internalByPublic.has(id) && id !== actorId));
      if (context.room.type === "hub") {
        if (context.room.ownerId !== actorId) {
          return [context.room.ownerId];
        }
        const participants = context.members.map((member) => member.userId).filter((id) => id !== actorId);
        return validTargets.size ? participants.filter((id) => validTargets.has(id)) : participants;
      }
      return context.members.map((member) => member.userId).filter((id) => id !== actorId);
    });
  }

  typingUpdate(principal: AuthPrincipal, spaceId: string, active: boolean): TypingUpdate {
    return {
      active,
      displayName: principal.state.user.displayName,
      spaceId,
      userId: principal.state.user.id
    };
  }

  async nextOutboxEvents(limit = 20) {
    return this.database.query<OutboxEventRow>(
      `select id, aggregate_id, event_type, payload_json, attempt_count
       from outbox_events
       where published_at is null
       order by created_at, id
       limit $1`,
      [limit]
    ).then((result) => result.rows);
  }

  async realtimeEnvelope(event: OutboxEventRow): Promise<RealtimeEnvelope | undefined> {
    const recipientInternalId = event.payload_json.recipientInternalId;
    if (!recipientInternalId) {
      return undefined;
    }
    const recipient = await this.database.query<{ public_id: string }>("select public_id from users where id = $1", [recipientInternalId]);
    const publicUserId = recipient.rows[0]?.public_id;
    if (!publicUserId) {
      return undefined;
    }
    if (event.event_type === "conversation.message.deleted") {
      return {
        event: "message:deleted",
        payload: { id: event.aggregate_id, deletedAt: event.payload_json.deletedAt ?? new Date().toISOString() },
        publicUserId
      };
    }
    const message = await this.messageForInternalViewer(event.aggregate_id, recipientInternalId);
    if (!message) {
      return undefined;
    }
    const eventName = event.event_type === "conversation.message.created"
      ? "message:created"
      : event.event_type === "conversation.message.updated"
        ? "message:updated"
        : "message:delivery-updated";
    return { event: eventName, payload: message, publicUserId };
  }

  markOutboxPublished(eventId: string) {
    return this.database.query(
      "update outbox_events set published_at = now(), attempt_count = attempt_count + 1, last_error = null where id = $1",
      [eventId]
    );
  }

  markOutboxFailed(eventId: string, error: unknown) {
    return this.database.query(
      `update outbox_events
       set attempt_count = attempt_count + 1, last_error = $2
       where id = $1`,
      [eventId, String(error instanceof Error ? error.message : error).slice(0, 500)]
    );
  }

  private async organization(organizationId: string): Promise<Organization> {
    const result = await this.database.query<Organization>(
      "select id, name, plan from organizations where id = $1",
      [organizationId]
    );
    if (!result.rows[0]) {
      throw new NotFoundException("Organization was not found.");
    }
    return result.rows[0];
  }

  private async messageForViewer(principal: AuthPrincipal, messageId: string) {
    return this.database.transaction(async (client) => {
      const row = await client.query<{ space_id: string }>("select space_id from messages where id = $1", [messageId]);
      const spaceId = row.rows[0]?.space_id;
      if (!spaceId) {
        throw new NotFoundException("Message was not found.");
      }
      const context = await this.spaceContext(client, spaceId, principal.state.user.organizationId);
      this.assertMembership(context, principal);
      const messages = await this.loadMessages(client, context, [messageId], principal.state.user.id);
      if (!messages[0]) {
        throw new NotFoundException("Message was not found.");
      }
      return messages[0];
    });
  }

  private async messageForInternalViewer(messageId: string, viewerInternalId: string) {
    return this.database.transaction(async (client) => {
      const row = await client.query<{ organization_id: string; space_id: string }>(
        `select s.organization_id, m.space_id
         from messages m join conversation_spaces s on s.id = m.space_id
         where m.id = $1`,
        [messageId]
      );
      const value = row.rows[0];
      if (!value) {
        return undefined;
      }
      const context = await this.spaceContext(client, value.space_id, value.organization_id);
      const publicId = context.publicByInternal.get(viewerInternalId);
      if (!publicId) {
        return undefined;
      }
      return (await this.loadMessages(client, context, [messageId], publicId))[0];
    });
  }

  private async spaceContext(client: PoolClient, spaceId: string, organizationId: string): Promise<SpaceContext> {
    const result = await client.query<SpaceMemberRow>(
      `select
         s.id as space_id,
         s.organization_id,
         s.type as space_type,
         s.name as space_name,
         s.owner_id as owner_internal_id,
         s.roster_visibility,
         s.settings_json,
         s.created_at as space_created_at,
         sm.user_id as internal_user_id,
         sm.role as space_role,
         sm.view_mode,
         sm.joined_at,
         sm.muted_until,
         sm.last_read_message_id,
         sm.last_read_at,
         u.public_id,
         u.email::text,
         u.display_name,
         u.status,
         u.last_seen_at,
         u.created_at,
         p.public_profile_json ->> 'characterId' as character_id
       from conversation_spaces s
       join space_memberships sm on sm.space_id = s.id and sm.status in ('active', 'muted')
       join users u on u.id = sm.user_id
       left join profiles p on p.user_id = u.id
       where s.id = $1 and s.organization_id = $2 and s.archived_at is null
       order by case sm.role when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end, sm.joined_at`,
      [spaceId, organizationId]
    );
    if (!result.rows.length) {
      throw new NotFoundException("Conversation was not found.");
    }
    const first = result.rows[0]!;
    const publicByInternal = new Map(result.rows.map((row) => [row.internal_user_id, row.public_id]));
    const internalByPublic = new Map(result.rows.map((row) => [row.public_id, row.internal_user_id]));
    const ownerPublicId = publicByInternal.get(first.owner_internal_id);
    if (!ownerPublicId) {
      throw new NotFoundException("Conversation owner membership is missing.");
    }
    const settings = first.settings_json ?? {};
    const room: Room = {
      createdAt: first.space_created_at.toISOString(),
      id: first.space_id,
      name: first.space_name,
      organizationId,
      ownerId: ownerPublicId,
      settings: {
        fileSharingEnabled: settings.fileSharingEnabled !== false,
        guestCanDownload: settings.guestCanDownload === true,
        publicAnnouncementsEnabled: settings.publicAnnouncementsEnabled === true,
        readReportEnabled: settings.readReportEnabled !== false,
        rosterVisibility: first.roster_visibility
      },
      type: first.space_type
    };
    const users: User[] = result.rows.map((row) => ({
      character: findCharacterPreset(row.character_id ?? ""),
      displayName: row.display_name,
      email: row.email,
      id: row.public_id,
      lastSeenAt: (row.last_seen_at ?? row.created_at).toISOString(),
      organizationId,
      status: row.status === "active" ? "active" : row.status === "invited" ? "invited" : "suspended"
    }));
    const members: RoomMember[] = result.rows.map((row) => ({
      joinedAt: row.joined_at.toISOString(),
      role: row.space_role,
      roomId: first.space_id,
      userId: row.public_id,
      viewMode: row.view_mode,
      ...(row.last_read_message_id ? { lastReadMessageId: row.last_read_message_id } : {}),
      ...(row.last_read_at ? { lastReadAt: row.last_read_at.toISOString() } : {}),
      ...(row.muted_until ? { mutedUntil: row.muted_until.toISOString() } : {})
    }));
    return { internalByPublic, members, publicByInternal, room, users };
  }

  private assertMembership(context: SpaceContext, principal: AuthPrincipal) {
    const membership = context.members.find((member) => member.userId === principal.state.user.id);
    if (!membership || context.internalByPublic.get(principal.state.user.id) !== principal.internalUserId) {
      throw new NotFoundException("Conversation membership was not found.");
    }
    return membership;
  }

  private async loadMessages(
    client: PoolClient,
    context: SpaceContext,
    messageIds: string[],
    viewerPublicId: string,
    forceFullDeliveries = false
  ) {
    if (!messageIds.length) {
      return [];
    }
    const messagesResult = await client.query<MessageRow>(
      `select
         m.id, m.space_id, sender.public_id as sender_public_id, m.sender_id,
         m.parent_message_id, m.message_type, m.delivery_mode, m.body,
         m.metadata_json, m.created_at, m.edited_at, m.deleted_at
       from messages m
       join users sender on sender.id = m.sender_id
       where m.id = any($1::uuid[])
       order by m.created_at, m.id`,
      [messageIds]
    );
    const audiencesResult = await client.query<AudienceRow>(
      `select ma.id, ma.message_id, ma.audience_type, target.public_id as target_public_id, ma.target_role
       from message_audiences ma
       left join users target on target.id = ma.target_user_id
       where ma.message_id = any($1::uuid[])
       order by ma.created_at, ma.id`,
      [messageIds]
    );
    const deliveriesResult = await client.query<DeliveryRow>(
      `select
         d.id, d.message_id, recipient.public_id as recipient_public_id,
         d.thread_key, d.status, d.delivered_at, d.read_at, d.confirmed_at,
         d.revoked_at, d.created_at
       from message_deliveries d
       join users recipient on recipient.id = d.recipient_id
       where d.message_id = any($1::uuid[])
       order by d.created_at, d.id`,
      [messageIds]
    );
    const viewerInternalId = context.internalByPublic.get(viewerPublicId);
    if (!viewerInternalId) return [];
    const attachmentsResult = await client.query<AttachmentRow>(
      `select attachment.message_id, asset.id as asset_id, asset.owner_id,
              owner.public_id as owner_public_id, asset.original_file_name,
              asset.detected_mime_type, asset.media_kind, asset.size_bytes,
              asset.archive_scope, asset.preview_status, asset.virus_scan_status,
              asset.processing_status, asset.source, asset.captured_at,
               to_char(asset.captured_local_at, 'YYYY-MM-DD"T"HH24:MI:SS') as captured_local_at,
               asset.captured_timezone, asset.place_name,
              asset.created_at, variant.object_key as preview_object_key,
              (asset.owner_id = $2 or coalesce(bool_or(media_grant.can_download), false)) as can_download
       from message_attachments attachment
       join media_assets asset on asset.id = attachment.asset_id and asset.deleted_at is null
       join users owner on owner.id = asset.owner_id
       left join media_variants variant
         on variant.asset_id = asset.id and variant.variant_kind = 'shared_preview'
       left join media_grants media_grant
         on media_grant.asset_id = asset.id and media_grant.message_id = attachment.message_id
        and media_grant.grantee_id = $2 and media_grant.revoked_at is null
       where attachment.message_id = any($1::uuid[]) and attachment.revoked_at is null
         and (asset.owner_id = $2 or media_grant.id is not null)
       group by attachment.message_id, asset.id, owner.public_id, variant.object_key
       order by attachment.message_id, min(attachment.position), asset.created_at, asset.id`,
      [messageIds, viewerInternalId]
    );
    const audiencesByMessage = new Map<string, MessageAudience[]>();
    for (const row of audiencesResult.rows) {
      const audience: MessageAudience = {
        audienceType: row.audience_type,
        id: row.id,
        messageId: row.message_id,
        ...(row.target_public_id ? { targetUserId: row.target_public_id } : {}),
        ...(row.target_role ? { targetRole: row.target_role } : {})
      };
      audiencesByMessage.set(row.message_id, [...(audiencesByMessage.get(row.message_id) ?? []), audience]);
    }
    const deliveriesByMessage = new Map<string, MessageDelivery[]>();
    for (const row of deliveriesResult.rows) {
      const delivery: MessageDelivery = {
        id: row.id,
        messageId: row.message_id,
        recipientId: row.recipient_public_id,
        status: row.status,
        threadKey: row.thread_key,
        ...(row.delivered_at ? { deliveredAt: row.delivered_at.toISOString() } : {}),
        ...(row.read_at ? { readAt: row.read_at.toISOString() } : {}),
        ...(row.confirmed_at ? { confirmedAt: row.confirmed_at.toISOString() } : {}),
        ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {})
      };
      deliveriesByMessage.set(row.message_id, [...(deliveriesByMessage.get(row.message_id) ?? []), delivery]);
    }
    const attachmentsByMessage = new Map<string, Attachment[]>();
    for (const row of attachmentsResult.rows) {
      const owner = row.owner_id === viewerInternalId;
      const ready = row.processing_status === "ready" && row.virus_scan_status === "clean";
      const previewAvailable = owner
        ? ready && ["image", "pdf", "video", "audio", "text"].includes(row.media_kind)
        : ready && row.preview_status === "ready" && (row.media_kind !== "image" || Boolean(row.preview_object_key));
      const capturedLocal = row.captured_local_at ?? undefined;
      const attachment: Attachment = {
        assetId: row.asset_id,
        canDownload: row.can_download,
        createdAt: row.created_at.toISOString(),
        fileName: row.original_file_name,
        id: `${row.message_id}:${row.asset_id}`,
        mediaKind: row.media_kind,
        mediaVisibility: row.archive_scope,
        messageId: row.message_id,
        mimeType: row.detected_mime_type,
        previewStatus: row.preview_status,
        sizeBytes: Number(row.size_bytes),
        source: row.source,
        uploaderId: row.owner_public_id,
        virusScanStatus: row.virus_scan_status,
        ...(owner && row.captured_at ? { capturedAt: row.captured_at.toISOString() } : owner && capturedLocal ? { capturedAt: capturedLocal } : {}),
        ...(owner && row.captured_timezone ? { capturedTimezone: row.captured_timezone } : {}),
        ...(owner && row.place_name ? { placeName: row.place_name } : {}),
        ...(previewAvailable ? { previewUrl: `/media/assets/${row.asset_id}/content?variant=${owner ? "original" : "preview"}` } : {}),
        ...(ready && row.can_download ? { downloadUrl: `/media/assets/${row.asset_id}/content?variant=original&download=1` } : {})
      };
      attachmentsByMessage.set(row.message_id, [...(attachmentsByMessage.get(row.message_id) ?? []), attachment]);
    }
    const viewerMembership = context.members.find((member) => member.userId === viewerPublicId);
    return messagesResult.rows
      .map((row): Message | undefined => {
        const message: Message = {
          attachments: attachmentsByMessage.get(row.id) ?? [],
          audiences: audiencesByMessage.get(row.id) ?? [],
          body: row.body,
          createdAt: row.created_at.toISOString(),
          deliveryMode: row.delivery_mode,
          deliveries: deliveriesByMessage.get(row.id) ?? [],
          id: row.id,
          messageType: row.message_type,
          metadata: row.metadata_json ?? {},
          roomId: row.space_id,
          senderId: row.sender_public_id,
          ...(row.parent_message_id ? { parentMessageId: row.parent_message_id } : {}),
          ...(row.edited_at ? { editedAt: row.edited_at.toISOString() } : {}),
          ...(row.deleted_at ? { deletedAt: row.deleted_at.toISOString() } : {})
        };
        const projected = projectMessageForViewer(message, context.room, context.members, viewerPublicId);
        if (!projected) {
          return undefined;
        }
        const canSeeReport = forceFullDeliveries
          || viewerPublicId === row.sender_public_id
          || context.room.ownerId === viewerPublicId
          || (context.room.type !== "hub" && ["owner", "admin"].includes(viewerMembership?.role ?? ""));
        if (context.room.type === "hub") {
          if (context.room.ownerId === viewerPublicId) {
            return projected;
          }
          if (forceFullDeliveries && viewerPublicId === row.sender_public_id) {
            return {
              ...projected,
              deliveries: message.deliveries.filter((delivery) => (
                delivery.recipientId === viewerPublicId || delivery.recipientId === context.room.ownerId
              ))
            };
          }
          return projected;
        }
        if (canSeeReport) {
          return projected;
        }
        const ownDelivery = projected.deliveries.find((delivery) => delivery.recipientId === viewerPublicId);
        return ownDelivery ? { ...projected, deliveries: [ownDelivery] } : undefined;
      })
      .filter((message): message is Message => Boolean(message));
  }

  private async insertAudience(
    client: PoolClient,
    context: SpaceContext,
    messageId: string,
    audienceType: AudienceType,
    targetUserIds: string[],
    targetRole?: MemberRole
  ) {
    if (audienceType === "all") {
      await client.query(
        "insert into message_audiences (message_id, audience_type) values ($1, 'all')",
        [messageId]
      );
      return;
    }
    if (audienceType === "role") {
      await client.query(
        "insert into message_audiences (message_id, audience_type, target_role) values ($1, 'role', $2)",
        [messageId, targetRole ?? "member"]
      );
      return;
    }
    for (const targetPublicId of targetUserIds) {
      const targetInternalId = context.internalByPublic.get(targetPublicId);
      if (targetInternalId) {
        await client.query(
          "insert into message_audiences (message_id, audience_type, target_user_id) values ($1, $2, $3)",
          [messageId, audienceType, targetInternalId]
        );
      }
    }
  }

  private insertOutbox(
    client: PoolClient,
    messageId: string,
    recipientInternalId: string,
    eventType: string,
    extra: Record<string, string> = {}
  ) {
    return client.query(
      `insert into outbox_events (aggregate_type, aggregate_id, event_type, payload_json)
       values ('message', $1, $2, $3::jsonb)`,
      [messageId, eventType, JSON.stringify({ recipientInternalId, ...extra })]
    );
  }

  private async enqueueExistingRecipients(
    client: PoolClient,
    messageId: string,
    eventType: string,
    extra: Record<string, string> = {}
  ) {
    const deliveries = await client.query<{ recipient_id: string }>(
      "select recipient_id from message_deliveries where message_id = $1 and revoked_at is null",
      [messageId]
    );
    for (const delivery of deliveries.rows) {
      await this.insertOutbox(client, messageId, delivery.recipient_id, eventType, extra);
    }
  }

  private async lockedMessage(client: PoolClient, messageId: string) {
    const result = await client.query<{
      deleted_at: Date | null;
      sender_id: string;
      space_id: string;
    }>("select space_id, sender_id, deleted_at from messages where id = $1 for update", [messageId]);
    if (!result.rows[0]) {
      throw new NotFoundException("Message was not found.");
    }
    return result.rows[0];
  }

  private async lockOwnedAsset(client: PoolClient, principal: AuthPrincipal, assetId: string) {
    const result = await client.query<{ deleted_at: Date | null; owner_id: string }>(
      "select owner_id, deleted_at from media_assets where id = $1 and organization_id = $2 for update",
      [assetId, principal.state.user.organizationId]
    );
    const asset = result.rows[0];
    if (!asset || asset.owner_id !== principal.internalUserId) {
      throw new NotFoundException("Owned media asset was not found.");
    }
    return asset;
  }

  private async revokeMediaMessage(client: PoolClient, assetId: string, messageId: string): Promise<MessageDeleteResult> {
    const link = await client.query<{ deleted_at: Date | null; revoked_at: Date | null }>(
      `select message.deleted_at, attachment.revoked_at
       from message_attachments attachment
       join messages message on message.id = attachment.message_id
       where attachment.asset_id = $1 and attachment.message_id = $2
       for update of attachment, message`,
      [assetId, messageId]
    );
    const row = link.rows[0];
    if (!row) throw new NotFoundException("Media share was not found.");
    const deletedAt = row.deleted_at ?? row.revoked_at ?? new Date();
    if (!row.revoked_at) {
      await this.enqueueExistingRecipients(client, messageId, "conversation.message.deleted", {
        deletedAt: deletedAt.toISOString()
      });
      await client.query(
        "update message_attachments set revoked_at = $3 where asset_id = $1 and message_id = $2",
        [assetId, messageId, deletedAt]
      );
      await client.query(
        `update media_grants set revoked_at = $3, revoke_reason = 'owner_revoked'
         where asset_id = $1 and message_id = $2 and revoked_at is null`,
        [assetId, messageId, deletedAt]
      );
      await client.query(
        `update message_deliveries
         set status = 'revoked', revoked_at = $2
         where message_id = $1 and revoked_at is null`,
        [messageId, deletedAt]
      );
      await client.query("update messages set deleted_at = coalesce(deleted_at, $2) where id = $1", [messageId, deletedAt]);
    }
    return { id: messageId, deletedAt: deletedAt.toISOString() };
  }
}
