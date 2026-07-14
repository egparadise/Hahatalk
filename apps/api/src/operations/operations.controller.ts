import { timingSafeEqual } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import type { Response } from "express";
import { CurrentAuth, PublicRoute } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";
import { AuditExportService } from "./audit-export.service.js";
import { LifecycleService } from "./lifecycle.service.js";
import { OperationalTelemetryService } from "./operational-telemetry.service.js";
import { ReleaseService, releaseGateNames } from "./release.service.js";

class CreateAuditExportDto {
  @IsDateString()
  fromAt = "";

  @IsDateString()
  toAt = "";

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_.-]{1,80}$/)
  actionPrefix?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  idempotencyKey = "";
}

class UpdateRetentionPolicyDto {
  @IsInt()
  @Min(1)
  @Max(3_650)
  retainDays = 1;

  @IsBoolean()
  enabled = true;

  @IsInt()
  @Min(1)
  expectedVersion = 1;
}

class CreateLegalHoldDto {
  @IsIn(["organization", "user", "conversation", "media"])
  scopeType: "organization" | "user" | "conversation" | "media" = "organization";

  @IsOptional()
  @IsUUID()
  scopeId?: string;

  @IsIn(["all", "operational_transient", "audit_export", "message", "media", "ai", "user_account"])
  dataClass: "all" | "operational_transient" | "audit_export" | "message" | "media" | "ai" | "user_account" = "all";

  @IsString()
  @Matches(/^[a-z0-9_.-]{2,80}$/)
  reasonCode = "";
}

class CreateLifecycleJobDto {
  @IsIn(["operational_cleanup", "audit_export_expiry", "user_deletion"])
  jobType: "operational_cleanup" | "audit_export_expiry" | "user_deletion" = "operational_cleanup";

  @IsBoolean()
  dryRun = true;

  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(120)
  idempotencyKey = "";
}

class CreateReleaseCandidateDto {
  @IsString()
  @Matches(/^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$/)
  version = "";

  @IsString()
  @Matches(/^[a-f0-9]{40}$/)
  gitSha = "";

  @IsString()
  @Matches(/^[0-9]{3}_[a-z0-9_-]+\.sql$/)
  schemaVersion = "";

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  manifestSha256 = "";

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  artifactSha256?: string;
}

class RecordReleaseGateDto {
  @IsIn([...releaseGateNames])
  gateName: typeof releaseGateNames[number] = "contracts";

  @IsIn(["passed", "failed", "pending_external"])
  result: "passed" | "failed" | "pending_external" = "pending_external";

  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  evidenceSha256?: string;

  @IsString()
  @Matches(/^[a-z0-9_.-]{2,80}$/)
  detailCode = "";
}

class SetRolloutDto {
  @IsInt()
  @IsIn([0, 1, 5, 25, 50, 100])
  rolloutPercent = 0;
}

@Controller("ops")
@UseGuards(ThrottlerGuard)
export class OperationsController {
  constructor(
    private readonly auditExports: AuditExportService,
    private readonly database: DatabaseService,
    private readonly lifecycle: LifecycleService,
    private readonly releases: ReleaseService,
    private readonly telemetry: OperationalTelemetryService
  ) {}

  @PublicRoute()
  @Get("health/live")
  live() {
    return { ok: true, service: "hahatalk-api", status: "live" };
  }

  @PublicRoute()
  @Get("health/ready")
  async ready() {
    const health = await this.database.health();
    const migration = await this.database.query<{ present: boolean }>(
      "select exists(select 1 from schema_migrations where version = '016_release_hardening_lifecycle_concurrency.sql') as present"
    );
    if (!migration.rows[0]?.present) throw new ServiceUnavailableException("Required schema is not installed.");
    const role = await this.database.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = current_user`
    );
    const rlsEnforced = !role.rows[0]?.rolsuper && !role.rows[0]?.rolbypassrls;
    const embeddedSingleUser = process.env.HAHATALK_DATABASE_MODE === "embedded-single-user";
    if (process.env.NODE_ENV === "production" && !rlsEnforced && !embeddedSingleUser) {
      throw new ServiceUnavailableException("Production database role must not bypass row-level security.");
    }
    return {
      database: {
        latencyMs: health.latencyMs,
        roleIsolation: rlsEnforced ? "enforced" : embeddedSingleUser ? "embedded-single-user" : "development-bypass",
        status: "up"
      },
      ok: true,
      schema: "016_release_hardening_lifecycle_concurrency.sql",
      status: "ready"
    };
  }

  @PublicRoute()
  @Get("metrics")
  metrics(@Headers("x-hahatalk-ops-token") token: string | undefined, @Res() response: Response) {
    this.verifyMetricsToken(token);
    response.setHeader("Cache-Control", "no-store");
    response.type("text/plain; version=0.0.4; charset=utf-8");
    response.send(this.telemetry.renderPrometheus());
  }

  @Post("audit-exports")
  createAuditExport(@Body() body: CreateAuditExportDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.auditExports.create(principal, body);
  }

  @Get("audit-exports/:exportId")
  getAuditExport(
    @Param("exportId", ParseUUIDPipe) exportId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.auditExports.get(principal, exportId);
  }

  @Get("audit-exports/:exportId/download")
  async downloadAuditExport(
    @Param("exportId", ParseUUIDPipe) exportId: string,
    @CurrentAuth() principal: AuthPrincipal,
    @Res() response: Response
  ) {
    const file = await this.auditExports.download(principal, exportId);
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("Digest", `sha-256=${Buffer.from(file.sha256, "hex").toString("base64")}`);
    response.type("application/json; charset=utf-8");
    response.send(file.content);
  }

  @Get("retention-policies")
  listRetentionPolicies(@CurrentAuth() principal: AuthPrincipal) {
    return this.lifecycle.listPolicies(principal);
  }

  @Patch("retention-policies/:dataClass")
  updateRetentionPolicy(
    @Param("dataClass") dataClass: "operational_transient" | "audit_export" | "message" | "media" | "ai" | "user_account",
    @Body() body: UpdateRetentionPolicyDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.lifecycle.updatePolicy(principal, dataClass, body);
  }

  @Get("legal-holds")
  listLegalHolds(@CurrentAuth() principal: AuthPrincipal) {
    return this.lifecycle.listHolds(principal);
  }

  @Post("legal-holds")
  createLegalHold(@Body() body: CreateLegalHoldDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.lifecycle.createHold(principal, body);
  }

  @Post("legal-holds/:holdId/release")
  @HttpCode(HttpStatus.OK)
  releaseLegalHold(
    @Param("holdId", ParseUUIDPipe) holdId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.lifecycle.releaseHold(principal, holdId);
  }

  @Post("lifecycle-jobs")
  createLifecycleJob(@Body() body: CreateLifecycleJobDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.lifecycle.createJob(principal, body);
  }

  @Get("lifecycle-jobs/:jobId")
  getLifecycleJob(
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.lifecycle.getJob(principal, jobId);
  }

  @Post("lifecycle-jobs/:jobId/approve")
  @HttpCode(HttpStatus.OK)
  approveLifecycleJob(
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.lifecycle.approveJob(principal, jobId);
  }

  @Post("lifecycle-jobs/:jobId/execute")
  @HttpCode(HttpStatus.OK)
  executeLifecycleJob(
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.lifecycle.executeJob(principal, jobId);
  }

  @Post("release-candidates")
  createReleaseCandidate(@Body() body: CreateReleaseCandidateDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.releases.create(principal, body);
  }

  @Get("release-candidates/:candidateId")
  getReleaseCandidate(
    @Param("candidateId", ParseUUIDPipe) candidateId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.releases.get(principal, candidateId);
  }

  @Post("release-candidates/:candidateId/gates")
  recordReleaseGate(
    @Param("candidateId", ParseUUIDPipe) candidateId: string,
    @Body() body: RecordReleaseGateDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.releases.recordGate(principal, candidateId, body);
  }

  @Post("release-candidates/:candidateId/finalize")
  @HttpCode(HttpStatus.OK)
  finalizeRelease(
    @Param("candidateId", ParseUUIDPipe) candidateId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.releases.finalize(principal, candidateId);
  }

  @Patch("release-candidates/:candidateId/rollout")
  setReleaseRollout(
    @Param("candidateId", ParseUUIDPipe) candidateId: string,
    @Body() body: SetRolloutDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.releases.setRollout(principal, candidateId, body.rolloutPercent);
  }

  @Post("release-candidates/:candidateId/rollback")
  @HttpCode(HttpStatus.OK)
  rollbackRelease(
    @Param("candidateId", ParseUUIDPipe) candidateId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.releases.rollback(principal, candidateId);
  }

  private verifyMetricsToken(token: string | undefined) {
    const expected = process.env.OPS_METRICS_TOKEN?.trim();
    if (!expected) throw new ServiceUnavailableException("Metrics endpoint is disabled.");
    const actualBuffer = Buffer.from(token ?? "", "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      throw new UnauthorizedException("Metrics token is invalid.");
    }
  }
}
