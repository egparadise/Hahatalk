import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { objectStoreToken, type ObjectStore } from "../media/object-store.js";
import { OperationalTelemetryService } from "./operational-telemetry.service.js";
import { OperationsContextService } from "./operations-context.service.js";

const maxExportRecords = 5_000;
const maxExportBytes = 10 * 1024 * 1024;
const forbiddenMetadataKey = /(authorization|body|content|cookie|email|file|identity|ip|key|name|object|participant|password|path|phone|provider|recipient|room|secret|text|token|transcript|voice)/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AuditExportInput {
  actionPrefix?: string;
  fromAt: string;
  idempotencyKey: string;
  toAt: string;
}

interface AuditExportRow {
  action_prefix: string | null;
  completed_at: Date | null;
  content_sha256: string | null;
  created_at: Date;
  expires_at: Date | null;
  failure_code: string | null;
  from_at: Date;
  id: string;
  object_key: string | null;
  record_count: number | null;
  requested_by: string;
  size_bytes: string | number | null;
  started_at: Date | null;
  status: "queued" | "processing" | "completed" | "failed" | "expired";
  to_at: Date;
}

interface AuditSourceRow {
  action: string;
  actor_id: string | null;
  created_at: Date;
  metadata_json: Record<string, unknown>;
  target_id: string | null;
  target_type: string;
}

@Injectable()
export class AuditExportService {
  constructor(
    private readonly context: OperationsContextService,
    private readonly telemetry: OperationalTelemetryService,
    @Inject(objectStoreToken) private readonly objects: ObjectStore
  ) {}

  async create(principal: AuthPrincipal, input: AuditExportInput) {
    const fromAt = new Date(input.fromAt);
    const toAt = new Date(input.toAt);
    if (!Number.isFinite(fromAt.getTime()) || !Number.isFinite(toAt.getTime()) || toAt <= fromAt) {
      throw new BadRequestException("Audit export range is invalid.");
    }
    if (toAt.getTime() - fromAt.getTime() > 366 * 24 * 60 * 60 * 1_000) {
      throw new BadRequestException("Audit export range cannot exceed 366 days.");
    }
    if (toAt.getTime() > Date.now() + 5 * 60_000) {
      throw new BadRequestException("Audit export end cannot be in the future.");
    }

    const idempotencyDigest = createHash("sha256").update(input.idempotencyKey).digest();
    const job = await this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      const inserted = await client.query<AuditExportRow>(
        `insert into audit_export_jobs (
           organization_id, requested_by, idempotency_digest, from_at, to_at, action_prefix
         ) values ($1, $2, $3, $4, $5, $6)
         on conflict (organization_id, requested_by, idempotency_digest) do nothing
         returning *`,
        [organizationId, principal.internalUserId, idempotencyDigest, fromAt, toAt, input.actionPrefix ?? null]
      );
      const row = inserted.rows[0] ?? (await client.query<AuditExportRow>(
        `select * from audit_export_jobs
         where organization_id = $1 and requested_by = $2 and idempotency_digest = $3`,
        [organizationId, principal.internalUserId, idempotencyDigest]
      )).rows[0];
      if (!row) throw new ConflictException("Audit export idempotency lookup failed.");
      if (
        row.from_at.getTime() !== fromAt.getTime()
        || row.to_at.getTime() !== toAt.getTime()
        || row.action_prefix !== (input.actionPrefix ?? null)
      ) {
        throw new ConflictException("Audit export idempotency key was reused with different input.");
      }
      let claimed = false;
      if (row.status === "queued" || (row.status === "processing" && row.started_at && row.started_at.getTime() < Date.now() - 5 * 60_000)) {
        const claim = await client.query(
          `update audit_export_jobs
           set status = 'processing', started_at = now(), updated_at = now()
           where id = $1
             and (status = 'queued' or (status = 'processing' and started_at < now() - interval '5 minutes'))
           returning id`,
          [row.id]
        );
        claimed = Boolean(claim.rowCount);
        if (claimed) row.status = "processing";
      }
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.audit_export_requested",
        "audit_export",
        row.id,
        { actionPrefix: input.actionPrefix ?? null, rangeDays: Math.ceil((toAt.getTime() - fromAt.getTime()) / 86_400_000) }
      );
      return { claimed, organizationId, row };
    });

    if (job.row.status === "completed" || job.row.status === "failed" || job.row.status === "expired") {
      return this.view(job.row);
    }
    if (job.row.status !== "processing" || !job.claimed) return this.view(job.row);

    let objectKey: string | undefined;
    try {
      const sourceRows = await this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
        const result = await client.query<AuditSourceRow>(
          `select actor_id, action, target_type, target_id, metadata_json, created_at
           from audit_logs
           where organization_id = $1
             and created_at >= $2 and created_at < $3
             and ($4::text is null or action like $4 || '%')
           order by created_at asc, id asc
           limit $5`,
          [organizationId, fromAt, toAt, input.actionPrefix ?? null, maxExportRecords + 1]
        );
        return result.rows;
      });
      if (sourceRows.length > maxExportRecords) {
        throw new BadRequestException("Audit export exceeds the 5,000 record limit. Narrow the range.");
      }
      const exportDocument = {
        format: "hahatalk-audit-export-v1",
        generatedAt: new Date().toISOString(),
        organizationRef: this.reference(job.row.id, job.organizationId),
        range: { fromAt: fromAt.toISOString(), toAt: toAt.toISOString() },
        records: sourceRows.map((row) => ({
          action: row.action,
          actorRef: row.actor_id ? this.reference(job.row.id, row.actor_id) : null,
          at: row.created_at.toISOString(),
          metadata: this.sanitizeMetadata(row.metadata_json),
          targetRef: row.target_id ? this.reference(job.row.id, row.target_id) : null,
          targetType: row.target_type
        }))
      };
      const content = Buffer.from(`${JSON.stringify(exportDocument, null, 2)}\n`, "utf8");
      if (content.byteLength > maxExportBytes) {
        throw new BadRequestException("Audit export exceeds the 10 MiB limit. Narrow the range.");
      }
      objectKey = `audit-exports/${job.organizationId}/${job.row.id}/${randomUUID()}.json`;
      const stored = await this.objects.putBuffer(objectKey, content);
      const ttlMinutes = Math.min(60, Math.max(5, Number(process.env.AUDIT_EXPORT_TTL_MINUTES ?? 15)));
      const completed = await this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
        const result = await client.query<AuditExportRow>(
          `update audit_export_jobs
           set status = 'completed', object_key = $2, content_sha256 = $3, size_bytes = $4,
               record_count = $5, completed_at = now(), expires_at = now() + ($6 * interval '1 minute'),
               updated_at = now()
           where id = $1 and organization_id = $7 and status = 'processing'
           returning *`,
          [job.row.id, objectKey, stored.sha256Hex, stored.sizeBytes, sourceRows.length, ttlMinutes, organizationId]
        );
        if (!result.rows[0]) throw new ConflictException("Audit export state changed during processing.");
        await this.context.writeAudit(
          client,
          organizationId,
          principal.internalUserId,
          "ops.audit_export_completed",
          "audit_export",
          job.row.id,
          { recordCount: sourceRows.length, sizeBytes: stored.sizeBytes }
        );
        return result.rows[0];
      });
      this.telemetry.incrementOperation("audit_export", "completed");
      return this.view(completed);
    } catch (error) {
      if (objectKey) await this.objects.remove(objectKey).catch(() => undefined);
      const failureCode = error instanceof BadRequestException ? "bounded_export_rejected" : "export_processing_failed";
      await this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
        await client.query(
          `update audit_export_jobs
           set status = 'failed', failure_code = $2, completed_at = now(), updated_at = now()
           where id = $1 and status = 'processing'`,
          [job.row.id, failureCode]
        );
        await this.context.writeAudit(
          client,
          organizationId,
          principal.internalUserId,
          "ops.audit_export_failed",
          "audit_export",
          job.row.id,
          { failureCode }
        );
      }).catch(() => undefined);
      this.telemetry.incrementOperation("audit_export", "failed");
      throw error;
    }
  }

  async get(principal: AuthPrincipal, id: string) {
    return this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      const result = await client.query<AuditExportRow>(
        "select * from audit_export_jobs where id = $1 and organization_id = $2",
        [id, organizationId]
      );
      if (!result.rows[0]) throw new NotFoundException("Audit export was not found.");
      return this.view(result.rows[0]);
    });
  }

  async download(principal: AuthPrincipal, id: string) {
    const row = await this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      const result = await client.query<AuditExportRow>(
        "select * from audit_export_jobs where id = $1 and organization_id = $2",
        [id, organizationId]
      );
      const current = result.rows[0];
      if (!current) throw new NotFoundException("Audit export was not found.");
      if (current.status !== "completed" || !current.object_key || !current.expires_at) {
        throw new ConflictException("Audit export is not available for download.");
      }
      if (current.expires_at.getTime() <= Date.now()) {
        throw new ConflictException("Audit export download expired.");
      }
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.audit_export_downloaded",
        "audit_export",
        id
      );
      return current;
    });
    const content = await this.objects.readBuffer(row.object_key!, maxExportBytes);
    if (createHash("sha256").update(content).digest("hex") !== row.content_sha256) {
      throw new ConflictException("Audit export integrity check failed.");
    }
    return { content, fileName: `hahatalk-audit-${id}.json`, sha256: row.content_sha256! };
  }

  private reference(exportId: string, value: string) {
    return createHash("sha256").update(`${exportId}:${value}`).digest("hex").slice(0, 20);
  }

  private sanitizeMetadata(value: unknown, depth = 0): unknown {
    if (depth > 3 || value === null || value === undefined) return null;
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      if (uuidPattern.test(value)) return "[identifier]";
      if (value.length > 80 || /[@\s/\\]/.test(value)) return "[redacted]";
      return value;
    }
    if (Array.isArray(value)) return { itemCount: value.length };
    if (typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, 40)
          .map(([key, entry]) => [
            key.slice(0, 80),
            forbiddenMetadataKey.test(key) ? "[redacted]" : this.sanitizeMetadata(entry, depth + 1)
          ])
      );
    }
    return "[redacted]";
  }

  private view(row: AuditExportRow) {
    return {
      actionPrefix: row.action_prefix,
      completedAt: row.completed_at?.toISOString() ?? null,
      contentSha256: row.content_sha256,
      createdAt: row.created_at.toISOString(),
      downloadAvailable: row.status === "completed" && Boolean(row.expires_at && row.expires_at.getTime() > Date.now()),
      expiresAt: row.expires_at?.toISOString() ?? null,
      failureCode: row.failure_code,
      fromAt: row.from_at.toISOString(),
      id: row.id,
      recordCount: row.record_count,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      status: row.status,
      toAt: row.to_at.toISOString()
    };
  }
}
