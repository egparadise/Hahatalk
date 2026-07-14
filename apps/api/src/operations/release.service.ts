import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { OperationalTelemetryService } from "./operational-telemetry.service.js";
import { OperationsContextService } from "./operations-context.service.js";

export const mandatoryReleaseGates = [
  "authorization",
  "backup_restore",
  "contracts",
  "dependency_audit",
  "full_harness",
  "load_reconnect",
  "schema",
  "windows_install"
] as const;

export const externalReleaseGates = [
  "legal_policy",
  "media_egress",
  "mobile_signing",
  "physical_devices",
  "production_infrastructure",
  "windows_signing"
] as const;

export const releaseGateNames = [...mandatoryReleaseGates, ...externalReleaseGates] as const;
type ReleaseGateName = typeof releaseGateNames[number];

interface ReleaseCandidateRow {
  artifact_sha256: string | null;
  created_at: Date;
  git_sha: string;
  id: string;
  manifest_sha256: string;
  rollout_percent: number;
  schema_version: string;
  status: "draft" | "candidate" | "approved" | "rejected" | "rolled_back";
  updated_at: Date;
  version: string;
}

interface ReleaseGateRow {
  checked_at: Date;
  detail_code: string;
  evidence_sha256: string | null;
  gate_name: ReleaseGateName;
  result: "passed" | "failed" | "pending_external";
}

interface CreateReleaseInput {
  artifactSha256?: string;
  gitSha: string;
  manifestSha256: string;
  schemaVersion: string;
  version: string;
}

@Injectable()
export class ReleaseService {
  constructor(
    private readonly context: OperationsContextService,
    private readonly telemetry: OperationalTelemetryService
  ) {}

  async create(principal: AuthPrincipal, input: CreateReleaseInput) {
    return this.context.run(principal, ["owner"], async (client, organizationId) => {
      const inserted = await client.query<ReleaseCandidateRow>(
        `insert into release_candidates (
           organization_id, created_by, version, git_sha, schema_version,
           manifest_sha256, artifact_sha256
         ) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (organization_id, version, git_sha) do nothing
         returning *`,
        [
          organizationId,
          principal.internalUserId,
          input.version,
          input.gitSha,
          input.schemaVersion,
          input.manifestSha256,
          input.artifactSha256 ?? null
        ]
      );
      const row = inserted.rows[0] ?? (await client.query<ReleaseCandidateRow>(
        `select * from release_candidates
         where organization_id = $1 and version = $2 and git_sha = $3`,
        [organizationId, input.version, input.gitSha]
      )).rows[0];
      if (!row) throw new ConflictException("Release candidate could not be created.");
      if (
        row.schema_version !== input.schemaVersion
        || row.manifest_sha256 !== input.manifestSha256
        || row.artifact_sha256 !== (input.artifactSha256 ?? null)
      ) {
        throw new ConflictException("Release identity was reused with different artifacts.");
      }
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.release_candidate_created",
        "release_candidate",
        row.id,
        { schemaVersion: row.schema_version, version: row.version }
      );
      return this.view(row, []);
    });
  }

  async get(principal: AuthPrincipal, candidateId: string) {
    return this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      const row = await client.query<ReleaseCandidateRow>(
        "select * from release_candidates where id = $1 and organization_id = $2",
        [candidateId, organizationId]
      );
      if (!row.rows[0]) throw new NotFoundException("Release candidate was not found.");
      const gates = await client.query<ReleaseGateRow>(
        `select gate_name, result, evidence_sha256, detail_code, checked_at
         from release_gate_results where candidate_id = $1 and organization_id = $2
         order by gate_name`,
        [candidateId, organizationId]
      );
      return this.view(row.rows[0], gates.rows);
    });
  }

  async recordGate(
    principal: AuthPrincipal,
    candidateId: string,
    input: {
      detailCode: string;
      evidenceSha256?: string;
      gateName: ReleaseGateName;
      result: "passed" | "failed" | "pending_external";
    }
  ) {
    if (input.result === "passed" && !input.evidenceSha256) {
      throw new ConflictException("Passed release gate requires evidence SHA-256.");
    }
    return this.context.run(principal, ["owner", "admin"], async (client, organizationId) => {
      const candidate = await client.query<ReleaseCandidateRow>(
        "select * from release_candidates where id = $1 and organization_id = $2 for update",
        [candidateId, organizationId]
      );
      if (!candidate.rows[0]) throw new NotFoundException("Release candidate was not found.");
      if (["approved", "rolled_back"].includes(candidate.rows[0].status)) {
        throw new ConflictException("Finalized release gate evidence is immutable.");
      }
      await client.query(
        `insert into release_gate_results (
           organization_id, candidate_id, recorded_by, gate_name, result,
           evidence_sha256, detail_code
         ) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (candidate_id, gate_name) do update
         set recorded_by = excluded.recorded_by, result = excluded.result,
             evidence_sha256 = excluded.evidence_sha256, detail_code = excluded.detail_code,
             checked_at = now()`,
        [
          organizationId,
          candidateId,
          principal.internalUserId,
          input.gateName,
          input.result,
          input.evidenceSha256 ?? null,
          input.detailCode
        ]
      );
      if (input.result === "failed") {
        await client.query(
          "update release_candidates set status = 'rejected', rollout_percent = 0, updated_at = now() where id = $1",
          [candidateId]
        );
      }
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.release_gate_recorded",
        "release_candidate",
        candidateId,
        { detailCode: input.detailCode, gateName: input.gateName, result: input.result }
      );
      this.telemetry.incrementOperation("release_gate", input.result);
      const current = await client.query<ReleaseCandidateRow>("select * from release_candidates where id = $1", [candidateId]);
      const gates = await client.query<ReleaseGateRow>(
        `select gate_name, result, evidence_sha256, detail_code, checked_at
         from release_gate_results where candidate_id = $1 order by gate_name`,
        [candidateId]
      );
      return this.view(current.rows[0]!, gates.rows);
    });
  }

  async finalize(principal: AuthPrincipal, candidateId: string) {
    return this.context.run(principal, ["owner"], async (client, organizationId) => {
      const candidate = await client.query<ReleaseCandidateRow>(
        "select * from release_candidates where id = $1 and organization_id = $2 for update",
        [candidateId, organizationId]
      );
      const row = candidate.rows[0];
      if (!row) throw new NotFoundException("Release candidate was not found.");
      if (row.status === "rolled_back") throw new ConflictException("Rolled-back release cannot be finalized.");
      const gates = await client.query<ReleaseGateRow>(
        `select gate_name, result, evidence_sha256, detail_code, checked_at
         from release_gate_results where candidate_id = $1 and organization_id = $2`,
        [candidateId, organizationId]
      );
      const byName = new Map(gates.rows.map((gate) => [gate.gate_name, gate]));
      const failed = gates.rows.find((gate) => gate.result === "failed");
      if (failed) {
        await client.query(
          "update release_candidates set status = 'rejected', rollout_percent = 0, updated_at = now() where id = $1",
          [candidateId]
        );
        throw new ConflictException(`Release gate failed: ${failed.gate_name}`);
      }
      const missingMandatory = mandatoryReleaseGates.filter((name) => byName.get(name)?.result !== "passed");
      if (missingMandatory.length) {
        throw new ConflictException(`Mandatory release gates are incomplete: ${missingMandatory.join(", ")}`);
      }
      const allExternalPassed = externalReleaseGates.every((name) => byName.get(name)?.result === "passed");
      const nextStatus = allExternalPassed && row.rollout_percent === 100 ? "approved" : "candidate";
      const updated = (await client.query<ReleaseCandidateRow>(
        "update release_candidates set status = $2, updated_at = now() where id = $1 returning *",
        [candidateId, nextStatus]
      )).rows[0]!;
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.release_finalized",
        "release_candidate",
        candidateId,
        { status: nextStatus }
      );
      this.telemetry.incrementOperation("release", nextStatus);
      return this.view(updated, gates.rows);
    });
  }

  async setRollout(principal: AuthPrincipal, candidateId: string, rolloutPercent: number) {
    const allowed = new Set([0, 1, 5, 25, 50, 100]);
    if (!allowed.has(rolloutPercent)) throw new ConflictException("Rollout percent must use an approved stage.");
    return this.context.run(principal, ["owner"], async (client, organizationId) => {
      const candidate = await client.query<ReleaseCandidateRow>(
        "select * from release_candidates where id = $1 and organization_id = $2 for update",
        [candidateId, organizationId]
      );
      const row = candidate.rows[0];
      if (!row) throw new NotFoundException("Release candidate was not found.");
      if (row.status !== "candidate" && row.status !== "approved") {
        throw new ConflictException("Only a validated candidate can enter rollout.");
      }
      if (rolloutPercent < row.rollout_percent) {
        throw new ConflictException("Use rollback instead of reducing a rollout stage.");
      }
      const external = await client.query<ReleaseGateRow>(
        `select gate_name, result, evidence_sha256, detail_code, checked_at
         from release_gate_results
         where candidate_id = $1 and gate_name = any($2::text[])`,
        [candidateId, [...externalReleaseGates]]
      );
      if (rolloutPercent > 0 && !externalReleaseGates.every((name) => external.rows.find((gate) => gate.gate_name === name)?.result === "passed")) {
        throw new ConflictException("External signing, device, infrastructure, media, and legal gates must pass before rollout.");
      }
      const status = rolloutPercent === 100 ? "approved" : row.status;
      const updated = (await client.query<ReleaseCandidateRow>(
        `update release_candidates
         set rollout_percent = $2, status = $3, updated_at = now()
         where id = $1 returning *`,
        [candidateId, rolloutPercent, status]
      )).rows[0]!;
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.release_rollout_updated",
        "release_candidate",
        candidateId,
        { rolloutPercent, status }
      );
      const gates = await client.query<ReleaseGateRow>(
        `select gate_name, result, evidence_sha256, detail_code, checked_at
         from release_gate_results where candidate_id = $1 order by gate_name`,
        [candidateId]
      );
      return this.view(updated, gates.rows);
    });
  }

  async rollback(principal: AuthPrincipal, candidateId: string) {
    return this.context.run(principal, ["owner"], async (client, organizationId) => {
      const updated = await client.query<ReleaseCandidateRow>(
        `update release_candidates
         set status = 'rolled_back', rollout_percent = 0, updated_at = now()
         where id = $1 and organization_id = $2 and status in ('candidate', 'approved')
         returning *`,
        [candidateId, organizationId]
      );
      if (!updated.rows[0]) throw new ConflictException("Release candidate cannot be rolled back in its current state.");
      await this.context.writeAudit(
        client,
        organizationId,
        principal.internalUserId,
        "ops.release_rolled_back",
        "release_candidate",
        candidateId
      );
      this.telemetry.incrementOperation("release", "rolled_back");
      const gates = await client.query<ReleaseGateRow>(
        `select gate_name, result, evidence_sha256, detail_code, checked_at
         from release_gate_results where candidate_id = $1 order by gate_name`,
        [candidateId]
      );
      return this.view(updated.rows[0], gates.rows);
    });
  }

  private view(row: ReleaseCandidateRow, gates: ReleaseGateRow[]) {
    const byName = new Map(gates.map((gate) => [gate.gate_name, gate]));
    return {
      artifactSha256: row.artifact_sha256,
      createdAt: row.created_at.toISOString(),
      gates: releaseGateNames.map((name) => {
        const gate = byName.get(name);
        return gate ? {
          checkedAt: gate.checked_at.toISOString(),
          detailCode: gate.detail_code,
          evidenceSha256: gate.evidence_sha256,
          name,
          result: gate.result
        } : { checkedAt: null, detailCode: "not_recorded", evidenceSha256: null, name, result: "missing" as const };
      }),
      gitSha: row.git_sha,
      id: row.id,
      manifestSha256: row.manifest_sha256,
      rolloutPercent: row.rollout_percent,
      schemaVersion: row.schema_version,
      status: row.status,
      updatedAt: row.updated_at.toISOString(),
      version: row.version
    };
  }
}
