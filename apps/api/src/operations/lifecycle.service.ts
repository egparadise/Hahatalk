import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { objectStoreToken, type ObjectStore } from "../media/object-store.js";
import { OperationalTelemetryService } from "./operational-telemetry.service.js";
import { OperationsContextService } from "./operations-context.service.js";

type RetentionDataClass = "operational_transient" | "audit_export" | "message" | "media" | "ai" | "user_account";
type LifecycleJobType = "operational_cleanup" | "audit_export_expiry" | "user_deletion";
type HoldDataClass = RetentionDataClass | "all";
type HoldScope = "organization" | "user" | "conversation" | "media";

const defaultRetentionDays: Record<RetentionDataClass, number> = {
  ai: 90,
  audit_export: 1,
  media: 365,
  message: 3_650,
  operational_transient: 7,
  user_account: 3_650
};

interface RetentionPolicyRow {
  data_class: RetentionDataClass;
  enabled: boolean;
  retain_days: number;
  updated_at: Date;
  version: number;
}

interface LegalHoldRow {
  created_at: Date;
  data_class: HoldDataClass;
  id: string;
  reason_code: string;
  released_at: Date | null;
  scope_id: string | null;
  scope_type: HoldScope;
  status: "active" | "released";
}

interface LifecycleJobRow {
  approved_at: Date | null;
  approved_by: string | null;
  completed_at: Date | null;
  created_at: Date;
  cutoff_at: Date | null;
  data_class: "operational_transient" | "audit_export" | "user_account";
  dry_run: boolean;
  failure_code: string | null;
  id: string;
  job_type: LifecycleJobType;
  legal_hold_id: string | null;
  preview_json: Record<string, unknown>;
  requested_by: string;
  result_json: Record<string, unknown>;
  started_at: Date | null;
  status: "requested" | "approved" | "running" | "completed" | "blocked" | "failed" | "cancelled";
  target_user_id: string | null;
}

interface CreateLifecycleInput {
  dryRun: boolean;
  idempotencyKey: string;
  jobType: LifecycleJobType;
  targetUserId?: string;
}

interface CreateHoldInput {
  dataClass: HoldDataClass;
  reasonCode: string;
  scopeId?: string;
  scopeType: HoldScope;
}

@Injectable()
export class LifecycleService {
  constructor(
    private readonly context: OperationsContextService,
    private readonly telemetry: OperationalTelemetryService,
    @Inject(objectStoreToken) private readonly objects: ObjectStore
  ) {}

  async listPolicies(principal: AuthPrincipal) {
    return this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      await this.ensurePolicies(client, organizationId, principal.internalUserId);
      const policies = await client.query<RetentionPolicyRow>(
        `select data_class, retain_days, enabled, version, updated_at
         from retention_policies
         where organization_id = $1
         order by data_class`,
        [organizationId]
      );
      return policies.rows.map((row) => this.policyView(row));
    });
  }

  async updatePolicy(
    principal: AuthPrincipal,
    dataClass: RetentionDataClass,
    input: { enabled: boolean; expectedVersion: number; retainDays: number }
  ) {
    return this.context.run(principal, ["owner"], async (client, organizationId) => {
      await this.ensurePolicies(client, organizationId, principal.internalUserId);
      const updated = await client.query<RetentionPolicyRow>(
        `update retention_policies
         set retain_days = $3, enabled = $4, version = version + 1,
             changed_by = $5, updated_at = now()
         where organization_id = $1 and data_class = $2 and version = $6
         returning data_class, retain_days, enabled, version, updated_at`,
        [organizationId, dataClass, input.retainDays, input.enabled, principal.internalUserId, input.expectedVersion]
      );
      if (!updated.rows[0]) throw new ConflictException("Retention policy version changed.");
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.retention_policy_updated",
        "retention_policy",
        null,
        { dataClass, enabled: input.enabled, retainDays: input.retainDays, version: updated.rows[0].version }
      );
      return this.policyView(updated.rows[0]);
    });
  }

  async listHolds(principal: AuthPrincipal) {
    return this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      const rows = await client.query<LegalHoldRow>(
        `select id, scope_type, scope_id, data_class, reason_code, status, created_at, released_at
         from legal_holds where organization_id = $1 order by created_at desc`,
        [organizationId]
      );
      return rows.rows.map((row) => this.holdView(row));
    });
  }

  async createHold(principal: AuthPrincipal, input: CreateHoldInput) {
    return this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      await this.validateHoldScope(client, organizationId, input.scopeType, input.scopeId);
      const inserted = await client.query<LegalHoldRow>(
        `insert into legal_holds (
           organization_id, created_by, scope_type, scope_id, data_class, reason_code
         ) values ($1, $2, $3, $4, $5, $6)
         on conflict do nothing
         returning id, scope_type, scope_id, data_class, reason_code, status, created_at, released_at`,
        [
          organizationId,
          principal.internalUserId,
          input.scopeType,
          input.scopeType === "organization" ? null : input.scopeId,
          input.dataClass,
          input.reasonCode
        ]
      );
      const row = inserted.rows[0] ?? (await client.query<LegalHoldRow>(
        `select id, scope_type, scope_id, data_class, reason_code, status, created_at, released_at
         from legal_holds
         where organization_id = $1 and scope_type = $2
           and coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
           and data_class = $4 and status = 'active'`,
        [organizationId, input.scopeType, input.scopeType === "organization" ? null : input.scopeId, input.dataClass]
      )).rows[0];
      if (!row) throw new ConflictException("Legal hold could not be created.");
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.legal_hold_created",
        "legal_hold",
        row.id,
        { dataClass: row.data_class, reasonCode: row.reason_code, scopeType: row.scope_type }
      );
      this.telemetry.incrementOperation("legal_hold", "created");
      return this.holdView(row);
    });
  }

  async releaseHold(principal: AuthPrincipal, holdId: string) {
    return this.context.run(principal, ["owner"], async (client, organizationId) => {
      const updated = await client.query<LegalHoldRow>(
        `update legal_holds
         set status = 'released', released_by = $3, released_at = now()
         where id = $1 and organization_id = $2 and status = 'active'
         returning id, scope_type, scope_id, data_class, reason_code, status, created_at, released_at`,
        [holdId, organizationId, principal.internalUserId]
      );
      if (!updated.rows[0]) throw new NotFoundException("Active legal hold was not found.");
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.legal_hold_released",
        "legal_hold",
        holdId,
        { dataClass: updated.rows[0].data_class, scopeType: updated.rows[0].scope_type }
      );
      this.telemetry.incrementOperation("legal_hold", "released");
      return this.holdView(updated.rows[0]);
    });
  }

  async createJob(principal: AuthPrincipal, input: CreateLifecycleInput) {
    const mapping = this.jobMapping(input.jobType);
    const idempotencyDigest = createHash("sha256").update(input.idempotencyKey).digest();
    return this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      await this.ensurePolicies(client, organizationId, principal.internalUserId);
      if (input.jobType === "user_deletion") {
        if (!input.targetUserId) throw new BadRequestException("User deletion requires a target user.");
        await this.assertExclusiveActiveMembership(client, organizationId, input.targetUserId);
      } else if (input.targetUserId) {
        throw new BadRequestException("This lifecycle job cannot target a user.");
      }

      const policy = await client.query<RetentionPolicyRow>(
        `select data_class, retain_days, enabled, version, updated_at
         from retention_policies where organization_id = $1 and data_class = $2`,
        [organizationId, mapping.dataClass]
      );
      if (!policy.rows[0]?.enabled) throw new ConflictException("Retention policy is disabled.");
      const cutoff = input.jobType === "user_deletion"
        ? null
        : (await client.query<{ cutoff: Date }>("select now() - make_interval(days => $1) as cutoff", [policy.rows[0].retain_days])).rows[0]!.cutoff;
      const preview = await this.preview(client, organizationId, input.jobType, cutoff, input.targetUserId);
      const hold = input.dryRun ? null : await this.activeHold(client, organizationId, mapping.dataClass, input.targetUserId);
      const status = input.dryRun ? "approved" : hold ? "blocked" : "requested";
      const inserted = await client.query<LifecycleJobRow>(
        `insert into data_lifecycle_jobs (
           organization_id, requested_by, idempotency_digest, job_type, data_class,
           target_user_id, dry_run, cutoff_at, status, preview_json, legal_hold_id, failure_code
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
         on conflict do nothing
         returning *`,
        [
          organizationId,
          principal.internalUserId,
          idempotencyDigest,
          input.jobType,
          mapping.dataClass,
          input.targetUserId ?? null,
          input.dryRun,
          cutoff,
          status,
          JSON.stringify(preview),
          hold?.id ?? null,
          hold ? "legal_hold_active" : null
        ]
      );
      const row = inserted.rows[0] ?? (await client.query<LifecycleJobRow>(
        `select * from data_lifecycle_jobs
         where organization_id = $1 and requested_by = $2 and idempotency_digest = $3`,
        [organizationId, principal.internalUserId, idempotencyDigest]
      )).rows[0];
      if (!row && input.jobType === "audit_export_expiry" && !input.dryRun) {
        throw new ConflictException("An audit-export expiry job is already active.");
      }
      if (!row) throw new ConflictException("Lifecycle idempotency lookup failed.");
      if (
        row.job_type !== input.jobType
        || row.target_user_id !== (input.targetUserId ?? null)
        || row.dry_run !== input.dryRun
      ) {
        throw new ConflictException("Lifecycle idempotency key was reused with different input.");
      }
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.lifecycle_requested",
        "data_lifecycle_job",
        row.id,
        { dryRun: row.dry_run, jobType: row.job_type, status: row.status }
      );
      return this.jobView(row);
    });
  }

  async getJob(principal: AuthPrincipal, jobId: string) {
    return this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      const row = await client.query<LifecycleJobRow>(
        "select * from data_lifecycle_jobs where id = $1 and organization_id = $2",
        [jobId, organizationId]
      );
      if (!row.rows[0]) throw new NotFoundException("Lifecycle job was not found.");
      return this.jobView(row.rows[0]);
    });
  }

  async approveJob(principal: AuthPrincipal, jobId: string) {
    const result = await this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      const locked = await client.query<LifecycleJobRow>(
        "select * from data_lifecycle_jobs where id = $1 and organization_id = $2 for update",
        [jobId, organizationId]
      );
      const row = locked.rows[0];
      if (!row) throw new NotFoundException("Lifecycle job was not found.");
      if (row.dry_run || row.status === "approved") return { blocked: false, row };
      if (!['requested', 'blocked'].includes(row.status)) throw new ConflictException("Lifecycle job cannot be approved in its current state.");
      if (row.requested_by === principal.internalUserId) throw new ConflictException("Lifecycle approval requires a second administrator.");
      const hold = await this.activeHold(client, organizationId, row.data_class, row.target_user_id ?? undefined);
      if (hold) {
        const blocked = (await client.query<LifecycleJobRow>(
          `update data_lifecycle_jobs
           set status = 'blocked', legal_hold_id = $2, failure_code = 'legal_hold_active', updated_at = now()
           where id = $1 returning *`,
          [jobId, hold.id]
        )).rows[0]!;
        return { blocked: true, row: blocked };
      }
      const approved = (await client.query<LifecycleJobRow>(
        `update data_lifecycle_jobs
         set status = 'approved', approved_by = $2, approved_at = now(),
             legal_hold_id = null, failure_code = null, updated_at = now()
         where id = $1 returning *`,
        [jobId, principal.internalUserId]
      )).rows[0]!;
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.lifecycle_approved",
        "data_lifecycle_job",
        jobId,
        { jobType: approved.job_type }
      );
      return { blocked: false, row: approved };
    });
    if (result.blocked) throw new ConflictException("Lifecycle job is blocked by an active legal hold.");
    return this.jobView(result.row);
  }

  async executeJob(principal: AuthPrincipal, jobId: string) {
    const prepared = await this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      const locked = await client.query<LifecycleJobRow>(
        "select * from data_lifecycle_jobs where id = $1 and organization_id = $2 for update",
        [jobId, organizationId]
      );
      const row = locked.rows[0];
      if (!row) throw new NotFoundException("Lifecycle job was not found.");
      if (row.status === "completed") return { kind: "complete" as const, row };
      if (!row.dry_run && !row.approved_by) throw new ConflictException("Lifecycle job requires second-administrator approval.");
      const staleExpiryRun = row.status === "running"
        && row.job_type === "audit_export_expiry"
        && Boolean(row.started_at && row.started_at.getTime() < Date.now() - 5 * 60_000);
      if (!['approved', 'blocked', 'failed'].includes(row.status) && !staleExpiryRun) {
        throw new ConflictException("Lifecycle job cannot execute in its current state.");
      }
      const hold = row.dry_run ? null : await this.activeHold(client, organizationId, row.data_class, row.target_user_id ?? undefined);
      if (hold) {
        const blocked = (await client.query<LifecycleJobRow>(
          `update data_lifecycle_jobs
           set status = 'blocked', legal_hold_id = $2, failure_code = 'legal_hold_active', updated_at = now()
           where id = $1 returning *`,
          [jobId, hold.id]
        )).rows[0]!;
        return { kind: "blocked" as const, row: blocked };
      }
      if (row.job_type === "user_deletion" && !row.dry_run && process.env.HAHATALK_DESTRUCTIVE_LIFECYCLE_ENABLED !== "true") {
        const blocked = (await client.query<LifecycleJobRow>(
          `update data_lifecycle_jobs
           set status = 'blocked', failure_code = 'destructive_lifecycle_disabled', updated_at = now()
           where id = $1 returning *`,
          [jobId]
        )).rows[0]!;
        return { kind: "disabled" as const, row: blocked };
      }

      await client.query(
        `update data_lifecycle_jobs
         set status = 'running', started_at = now(), completed_at = null,
             failure_code = null, legal_hold_id = null, updated_at = now()
         where id = $1`,
        [jobId]
      );
      if (row.dry_run) {
        const completed = await this.completeJob(client, row.id, row.preview_json);
        await this.writeLifecycleCompleted(client, organizationId, principal.internalUserId, completed);
        return { kind: "complete" as const, row: completed };
      }
      if (row.job_type === "operational_cleanup") {
        const result = await this.executeOperationalCleanup(client, organizationId, row.cutoff_at!);
        const completed = await this.completeJob(client, row.id, result);
        await this.writeLifecycleCompleted(client, organizationId, principal.internalUserId, completed);
        return { kind: "complete" as const, row: completed };
      }
      if (row.job_type === "user_deletion") {
        const result = await this.executeUserDeletion(client, organizationId, row.target_user_id!);
        const completed = await this.completeJob(client, row.id, result);
        await this.writeLifecycleCompleted(client, organizationId, principal.internalUserId, completed);
        return { kind: "complete" as const, row: completed };
      }

      const exports = await client.query<{ id: string; object_key: string }>(
        `select id, object_key
         from audit_export_jobs
         where organization_id = $1 and object_key is not null and created_at < $2
           and ((status = 'completed' and expires_at <= now()) or status = 'expired')
         for update`,
        [organizationId, row.cutoff_at]
      );
      await client.query(
        `update audit_export_jobs
         set status = 'expired', updated_at = now()
         where organization_id = $1 and id = any($2::uuid[])`,
        [organizationId, exports.rows.map((item) => item.id)]
      );
      return { kind: "objects" as const, organizationId, row, exports: exports.rows };
    });

    if (prepared.kind === "blocked") {
      this.telemetry.incrementOperation("lifecycle", "blocked_legal_hold");
      throw new ConflictException("Lifecycle job is blocked by an active legal hold.");
    }
    if (prepared.kind === "disabled") {
      this.telemetry.incrementOperation("lifecycle", "blocked_configuration");
      throw new ConflictException("Destructive lifecycle execution is disabled by deployment policy.");
    }
    if (prepared.kind === "complete") {
      this.telemetry.incrementOperation("lifecycle", "completed");
      return this.jobView(prepared.row);
    }

    try {
      for (const item of prepared.exports) await this.objects.remove(item.object_key);
      const completed = await this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
        await client.query(
          `update audit_export_jobs
           set object_key = null, content_sha256 = null, size_bytes = null,
               record_count = null, updated_at = now()
           where organization_id = $1 and id = any($2::uuid[]) and status = 'expired'`,
          [organizationId, prepared.exports.map((item) => item.id)]
        );
        const row = await this.completeJob(client, jobId, { expiredAuditExports: prepared.exports.length });
        await this.writeLifecycleCompleted(client, organizationId, principal.internalUserId, row);
        return row;
      });
      this.telemetry.incrementOperation("lifecycle", "completed");
      return this.jobView(completed);
    } catch (error) {
      await this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
        await client.query(
          `update audit_export_jobs
           set status = 'completed', updated_at = now()
           where organization_id = $1 and id = any($2::uuid[])
             and status = 'expired' and object_key is not null`,
          [organizationId, prepared.exports.map((item) => item.id)]
        );
        await client.query(
          `update data_lifecycle_jobs
           set status = 'failed', failure_code = 'object_delete_failed', completed_at = now(), updated_at = now()
           where id = $1`,
          [jobId]
        );
        await this.context.writeAudit(
          client,
          organizationId,
          principal.internalUserId,
          "ops.lifecycle_failed",
          "data_lifecycle_job",
          jobId,
          { failureCode: "object_delete_failed" }
        );
      }).catch(() => undefined);
      this.telemetry.incrementOperation("lifecycle", "failed");
      throw error;
    }
  }

  private async ensurePolicies(client: PoolClient, organizationId: string, actorId: string) {
    for (const [dataClass, retainDays] of Object.entries(defaultRetentionDays)) {
      await client.query(
        `insert into retention_policies (
           organization_id, data_class, retain_days, changed_by
         ) values ($1, $2, $3, $4)
         on conflict (organization_id, data_class) do nothing`,
        [organizationId, dataClass, retainDays, actorId]
      );
    }
  }

  private async validateHoldScope(
    client: PoolClient,
    organizationId: string,
    scopeType: HoldScope,
    scopeId: string | undefined
  ) {
    if (scopeType === "organization") {
      if (scopeId) throw new BadRequestException("Organization hold cannot include a scope ID.");
      return;
    }
    if (!scopeId) throw new BadRequestException("Scoped legal hold requires a scope ID.");
    const checks: Record<Exclude<HoldScope, "organization">, string> = {
      conversation: "select 1 from conversation_spaces where id = $2 and organization_id = $1",
      media: "select 1 from media_assets where id = $2 and organization_id = $1",
      user: "select 1 from organization_memberships where user_id = $2 and organization_id = $1"
    };
    const found = await client.query(checks[scopeType], [organizationId, scopeId]);
    if (!found.rowCount) throw new NotFoundException("Legal hold scope was not found in the organization.");
  }

  private async assertExclusiveActiveMembership(
    client: PoolClient,
    organizationId: string,
    targetUserId: string,
    lock = false
  ) {
    const memberships = await client.query<{ organization_id: string; role: string }>(
      `select organization_id, role
       from organization_memberships
       where user_id = $1 and status = 'active'
       ${lock ? "for update" : ""}`,
      [targetUserId]
    );
    const current = memberships.rows.find((membership) => membership.organization_id === organizationId);
    if (!current) throw new NotFoundException("Target organization member was not found.");
    if (current.role === "owner") {
      throw new ConflictException("Organization owner cannot be deleted by lifecycle automation.");
    }
    if (memberships.rows.length !== 1) {
      throw new ConflictException("Account deletion requires exactly one active organization membership.");
    }
  }

  private async activeHold(
    client: PoolClient,
    organizationId: string,
    dataClass: string,
    targetUserId?: string
  ) {
    const result = await client.query<{ id: string }>(
      `select id from legal_holds
       where organization_id = $1 and status = 'active'
         and data_class in ('all', $2)
         and (scope_type = 'organization' or (scope_type = 'user' and scope_id = $3))
       order by created_at asc limit 1`,
      [organizationId, dataClass, targetUserId ?? null]
    );
    return result.rows[0];
  }

  private jobMapping(jobType: LifecycleJobType) {
    if (jobType === "operational_cleanup") return { dataClass: "operational_transient" as const };
    if (jobType === "audit_export_expiry") return { dataClass: "audit_export" as const };
    return { dataClass: "user_account" as const };
  }

  private async preview(
    client: PoolClient,
    organizationId: string,
    jobType: LifecycleJobType,
    cutoff: Date | null,
    targetUserId?: string
  ) {
    if (jobType === "audit_export_expiry") {
      const count = await client.query<{ count: string }>(
        `select count(*)::text as count from audit_export_jobs
         where organization_id = $1 and status = 'completed'
           and expires_at <= now() and created_at < $2`,
        [organizationId, cutoff]
      );
      return { expiredAuditExports: Number(count.rows[0]!.count) };
    }
    if (jobType === "operational_cleanup") {
      const counts = await client.query<{
        push_jobs: string;
        refresh_tokens: string;
        web_sessions: string;
      }>(
        `select
           (select count(*) from mobile_push_jobs
             where organization_id = $1 and status in ('delivered', 'failed', 'cancelled', 'expired')
               and updated_at < $2)::text as push_jobs,
           (select count(*) from mobile_refresh_tokens mrt
             join mobile_sessions ms on ms.id = mrt.session_id
             where ms.organization_id = $1 and mrt.status <> 'active' and mrt.created_at < $2)::text as refresh_tokens,
           (select count(*) from web_sessions ws
             join organization_memberships om on om.user_id = ws.user_id and om.organization_id = $1
             where ws.revoked_at is not null and ws.revoked_at < $2)::text as web_sessions`,
        [organizationId, cutoff]
      );
      return {
        pushJobs: Number(counts.rows[0]!.push_jobs),
        refreshTokens: Number(counts.rows[0]!.refresh_tokens),
        webSessions: Number(counts.rows[0]!.web_sessions)
      };
    }
    const counts = await client.query<{
      media_assets: string;
      memberships: string;
      messages: string;
      sessions: string;
      voice_profiles: string;
    }>(
      `select
         (select count(*) from organization_memberships where organization_id = $1 and user_id = $2)::text as memberships,
         (select count(*) from messages where sender_id = $2)::text as messages,
         (select count(*) from media_assets where organization_id = $1 and owner_id = $2 and deleted_at is null)::text as media_assets,
         ((select count(*) from web_sessions where user_id = $2)
           + (select count(*) from mobile_sessions where organization_id = $1 and user_id = $2))::text as sessions,
         (select count(*) from voice_profiles where organization_id = $1 and subject_user_id = $2 and status in ('pending', 'active'))::text as voice_profiles`,
      [organizationId, targetUserId]
    );
    return {
      mediaAssets: Number(counts.rows[0]!.media_assets),
      memberships: Number(counts.rows[0]!.memberships),
      messagesRetainedAsBusinessRecords: Number(counts.rows[0]!.messages),
      sessions: Number(counts.rows[0]!.sessions),
      voiceProfilesRevoked: Number(counts.rows[0]!.voice_profiles)
    };
  }

  private async executeOperationalCleanup(client: PoolClient, organizationId: string, cutoff: Date) {
    const attempts = await client.query(
      `delete from mobile_push_attempts mpa
       using mobile_push_jobs mpj
       where mpa.job_id = mpj.id and mpj.organization_id = $1
         and mpj.status in ('delivered', 'failed', 'cancelled', 'expired') and mpj.updated_at < $2`,
      [organizationId, cutoff]
    );
    const pushJobs = await client.query(
      `delete from mobile_push_jobs
       where organization_id = $1 and status in ('delivered', 'failed', 'cancelled', 'expired')
         and updated_at < $2`,
      [organizationId, cutoff]
    );
    const refreshTokens = await client.query(
      `delete from mobile_refresh_tokens mrt
       using mobile_sessions ms
       where mrt.session_id = ms.id and ms.organization_id = $1
         and mrt.status <> 'active' and mrt.created_at < $2`,
      [organizationId, cutoff]
    );
    const webSessions = await client.query(
      `delete from web_sessions ws
       using organization_memberships om
       where ws.user_id = om.user_id and om.organization_id = $1
         and ws.revoked_at is not null and ws.revoked_at < $2`,
      [organizationId, cutoff]
    );
    return {
      pushAttemptsDeleted: attempts.rowCount ?? 0,
      pushJobsDeleted: pushJobs.rowCount ?? 0,
      refreshTokensDeleted: refreshTokens.rowCount ?? 0,
      webSessionsDeleted: webSessions.rowCount ?? 0
    };
  }

  private async executeUserDeletion(client: PoolClient, organizationId: string, targetUserId: string) {
    const account = await client.query("select id from users where id = $1 for update", [targetUserId]);
    if (!account.rows[0]) throw new NotFoundException("Target user was not found.");
    await this.assertExclusiveActiveMembership(client, organizationId, targetUserId, true);
    const alias = createHash("sha256").update(targetUserId).digest("hex").slice(0, 24);
    const webSessions = await client.query(
      `update web_sessions
       set revoked_at = coalesce(revoked_at, now()), revoke_reason = 'account_deleted'
       where user_id = $1 and revoked_at is null`,
      [targetUserId]
    );
    const mobileSessions = await client.query(
      `update mobile_sessions
       set revoked_at = coalesce(revoked_at, now()), revoke_reason = 'account_deleted'
       where organization_id = $1 and user_id = $2 and revoked_at is null`,
      [organizationId, targetUserId]
    );
    await client.query(
      `update mobile_devices
       set status = 'revoked', revoked_at = coalesce(revoked_at, now()),
           revoke_reason = 'account_deleted', updated_at = now()
       where organization_id = $1 and user_id = $2 and status = 'active'`,
      [organizationId, targetUserId]
    );
    await client.query(
      `update mobile_push_jobs
       set status = 'cancelled', completed_at = coalesce(completed_at, now()), updated_at = now()
       where organization_id = $1 and recipient_id = $2 and status in ('queued', 'claimed')`,
      [organizationId, targetUserId]
    );
    const media = await client.query(
      `update media_assets set deleted_at = coalesce(deleted_at, now()), updated_at = now()
       where organization_id = $1 and owner_id = $2 and deleted_at is null`,
      [organizationId, targetUserId]
    );
    await client.query(
      `update voice_profile_consents
       set status = 'revoked', revoked_at = now()
       where organization_id = $1 and subject_user_id = $2 and status = 'active'`,
      [organizationId, targetUserId]
    );
    const voices = await client.query(
      `update voice_profiles
       set status = 'revoked', revoked_at = coalesce(revoked_at, now())
       where organization_id = $1 and subject_user_id = $2 and status in ('pending', 'active')`,
      [organizationId, targetUserId]
    );
    await client.query(
      `update profiles
       set title = null, department = null, company = null, bio = null,
           work_hours_json = '{}', public_profile_json = '{}', updated_at = now()
       where user_id = $1`,
      [targetUserId]
    );
    await client.query(
      `update organization_memberships
       set status = 'left'
       where organization_id = $1 and user_id = $2`,
      [organizationId, targetUserId]
    );
    await client.query(
      `update users
       set email = $2, phone = null, password_hash = null, display_name = 'Deleted user',
           status = 'deleted', auth_version = auth_version + 1, updated_at = now()
       where id = $1`,
      [targetUserId, `deleted+${alias}@invalid.hahatalk`]
    );
    return {
      mediaAssetsLogicallyDeleted: media.rowCount ?? 0,
      mobileSessionsRevoked: mobileSessions.rowCount ?? 0,
      userAnonymized: 1,
      voiceProfilesRevoked: voices.rowCount ?? 0,
      webSessionsRevoked: webSessions.rowCount ?? 0
    };
  }

  private async completeJob(client: PoolClient, jobId: string, result: Record<string, unknown>) {
    return (await client.query<LifecycleJobRow>(
      `update data_lifecycle_jobs
       set status = 'completed', result_json = $2::jsonb, failure_code = null,
           completed_at = now(), updated_at = now()
       where id = $1 returning *`,
      [jobId, JSON.stringify(result)]
    )).rows[0]!;
  }

  private async writeLifecycleCompleted(
    client: PoolClient,
    organizationId: string,
    actorId: string,
    row: LifecycleJobRow
  ) {
    await this.context.writeAudit(
      client,
      organizationId,
      actorId,
      "ops.lifecycle_completed",
      "data_lifecycle_job",
      row.id,
      { dryRun: row.dry_run, jobType: row.job_type, result: row.result_json }
    );
  }

  private policyView(row: RetentionPolicyRow) {
    return {
      dataClass: row.data_class,
      enabled: row.enabled,
      retainDays: row.retain_days,
      updatedAt: row.updated_at.toISOString(),
      version: row.version
    };
  }

  private holdView(row: LegalHoldRow) {
    return {
      createdAt: row.created_at.toISOString(),
      dataClass: row.data_class,
      id: row.id,
      reasonCode: row.reason_code,
      releasedAt: row.released_at?.toISOString() ?? null,
      scopeId: row.scope_id,
      scopeType: row.scope_type,
      status: row.status
    };
  }

  private jobView(row: LifecycleJobRow) {
    return {
      approvedAt: row.approved_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      cutoffAt: row.cutoff_at?.toISOString() ?? null,
      dataClass: row.data_class,
      dryRun: row.dry_run,
      failureCode: row.failure_code,
      id: row.id,
      jobType: row.job_type,
      legalHoldId: row.legal_hold_id,
      preview: row.preview_json,
      result: row.result_json,
      status: row.status,
      targetUserId: row.target_user_id
    };
  }
}
