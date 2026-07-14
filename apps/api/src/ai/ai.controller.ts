import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { AudienceType, MemberRole, SendConversationMessageInput } from "@hahatalk/contracts";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import type { Request, Response } from "express";
import { CurrentAuth, PublicRoute } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { AiService } from "./ai.service.js";

class IdempotentDto {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  idempotencyKey = "";
}

class CreateSttDto extends IdempotentDto {
  @IsUUID()
  assetId = "";

  @IsOptional()
  @IsString()
  @MaxLength(24)
  language?: string;
}

class CreateSummaryDto extends IdempotentDto {
  @IsUUID()
  spaceId = "";
}

class CreateTtsDto extends IdempotentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  text = "";

  @IsOptional()
  @IsString()
  @MaxLength(80)
  voiceId?: string;

  @IsOptional()
  @IsUUID()
  voiceProfileId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(2)
  speed?: number;
}

class CreateAvatarDto extends IdempotentDto {
  @IsUUID()
  assetId = "";

  @IsBoolean()
  consentToStoreSource = false;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  style?: string;
}

class EditTranscriptDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  text = "";
}

class SendTranscriptDto {
  @IsUUID()
  spaceId = "";

  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientMessageId = "";

  @IsIn(["all", "selected", "private", "role"])
  audienceType: AudienceType = "all";

  @IsArray()
  @IsString({ each: true })
  targetUserIds: string[] = [];

  @IsOptional()
  @IsIn(["owner", "admin", "member", "guest", "subscriber"])
  targetRole?: MemberRole;

  @IsBoolean()
  requiresConfirmation = false;
}

class CreateVoiceConsentDto {
  @IsUUID()
  referenceAssetId = "";

  @IsBoolean()
  acknowledged = false;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  expiresInDays?: number;
}

class CreateVoiceProfileDto extends IdempotentDto {
  @IsUUID()
  consentId = "";
}

class WorkerClaimDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  workerId = "";

  @IsArray()
  @IsString({ each: true })
  capabilities: string[] = [];

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(120)
  leaseSeconds?: number;
}

class WorkerLeaseDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  workerId = "";

  @IsInt()
  @Min(1)
  fencingToken = 0;
}

class WorkerHeartbeatDto extends WorkerLeaseDto {
  @IsNumber()
  @Min(1)
  @Max(99)
  progress = 1;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(120)
  leaseSeconds?: number;
}

class WorkerCompleteDto extends WorkerLeaseDto {
  @IsObject()
  result: Record<string, unknown> = {};
}

class WorkerFailDto extends WorkerLeaseDto {
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  errorCode = "worker_failed";

  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;

  @IsBoolean()
  retryable = false;
}

@Controller("ai")
@UseGuards(ThrottlerGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get("capabilities")
  capabilities() {
    return this.ai.capabilities();
  }

  @Get("jobs")
  listJobs(@CurrentAuth() principal: AuthPrincipal, @Query("spaceId") spaceId?: string) {
    return this.ai.listJobs(principal, spaceId);
  }

  @Get("jobs/:jobId")
  getJob(@Param("jobId", ParseUUIDPipe) jobId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.ai.getJob(principal, jobId);
  }

  @Post("jobs/stt")
  createStt(@Body() body: CreateSttDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.ai.createStt(principal, body);
  }

  @Post("jobs/summary")
  createSummary(@Body() body: CreateSummaryDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.ai.createSummary(principal, body);
  }

  @Post("jobs/tts")
  createTts(@Body() body: CreateTtsDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.ai.createTts(principal, body);
  }

  @Post("jobs/avatar")
  createAvatar(@Body() body: CreateAvatarDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.ai.createAvatar(principal, body);
  }

  @Post("jobs/:jobId/cancel")
  cancel(@Param("jobId", ParseUUIDPipe) jobId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.ai.cancelJob(principal, jobId);
  }

  @Post("jobs/:jobId/retry")
  retry(@Param("jobId", ParseUUIDPipe) jobId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.ai.retryJob(principal, jobId);
  }

  @Patch("transcripts/:transcriptId")
  editTranscript(
    @Param("transcriptId", ParseUUIDPipe) transcriptId: string,
    @Body() body: EditTranscriptDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.ai.editTranscript(principal, transcriptId, body.text);
  }

  @Post("transcripts/:transcriptId/reject")
  rejectTranscript(
    @Param("transcriptId", ParseUUIDPipe) transcriptId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.ai.rejectTranscript(principal, transcriptId);
  }

  @Post("transcripts/:transcriptId/send")
  sendTranscript(
    @Param("transcriptId", ParseUUIDPipe) transcriptId: string,
    @Body() body: SendTranscriptDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    const input: SendConversationMessageInput = {
      spaceId: body.spaceId,
      clientMessageId: body.clientMessageId,
      body: "AI transcript draft",
      audienceType: body.audienceType,
      targetUserIds: body.targetUserIds,
      ...(body.targetRole ? { targetRole: body.targetRole } : {}),
      requiresConfirmation: body.requiresConfirmation
    };
    return this.ai.sendTranscript(principal, transcriptId, input);
  }

  @Post("voice-consents")
  createVoiceConsent(@Body() body: CreateVoiceConsentDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.ai.createVoiceConsent(principal, body);
  }

  @Post("voice-profiles")
  createVoiceProfile(@Body() body: CreateVoiceProfileDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.ai.createVoiceProfile(principal, body);
  }

  @Get("voice-profiles")
  listVoiceProfiles(@CurrentAuth() principal: AuthPrincipal) {
    return this.ai.listVoiceProfiles(principal);
  }

  @Delete("voice-profiles/:profileId")
  revokeVoiceProfile(
    @Param("profileId", ParseUUIDPipe) profileId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.ai.revokeVoiceProfile(principal, profileId);
  }

  @Get("avatars")
  avatars(@CurrentAuth() principal: AuthPrincipal) {
    return this.ai.listAvatars(principal);
  }
}

@PublicRoute()
@Controller("internal/ai")
@UseGuards(ThrottlerGuard)
export class AiWorkerController {
  constructor(private readonly ai: AiService) {}

  @Post("jobs/claim")
  claim(
    @Headers("x-hahatalk-ai-worker-token") token: string | undefined,
    @Body() body: WorkerClaimDto
  ) {
    this.ai.assertWorkerToken(token);
    return this.ai.claimWorkerJob(body.workerId, body.capabilities, body.leaseSeconds);
  }

  @Post("jobs/:jobId/heartbeat")
  heartbeat(
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Headers("x-hahatalk-ai-worker-token") token: string | undefined,
    @Body() body: WorkerHeartbeatDto
  ) {
    this.ai.assertWorkerToken(token);
    return this.ai.heartbeatWorker(jobId, body.workerId, body.fencingToken, body.progress, body.leaseSeconds);
  }

  @Post("jobs/:jobId/complete")
  complete(
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Headers("x-hahatalk-ai-worker-token") token: string | undefined,
    @Body() body: WorkerCompleteDto
  ) {
    this.ai.assertWorkerToken(token);
    return this.ai.completeWorkerJob(jobId, body.workerId, body.fencingToken, body.result);
  }

  @Post("jobs/:jobId/fail")
  fail(
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Headers("x-hahatalk-ai-worker-token") token: string | undefined,
    @Body() body: WorkerFailDto
  ) {
    this.ai.assertWorkerToken(token);
    return this.ai.failWorkerJob(jobId, body.workerId, body.fencingToken, body);
  }

  @Get("jobs/:jobId/input")
  async input(
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Headers("x-hahatalk-ai-worker-token") token: string | undefined,
    @Headers("x-hahatalk-ai-worker-id") workerId: string | undefined,
    @Headers("x-hahatalk-ai-fencing-token") rawFencingToken: string | undefined,
    @Res() response: Response
  ) {
    this.ai.assertWorkerToken(token);
    const content = await this.ai.workerInput(jobId, workerId ?? "", this.fencingToken(rawFencingToken));
    response.status(200);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Length", String(content.sizeBytes));
    response.setHeader("Content-Type", content.mimeType);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(content.fileName)}`);
    content.stream.once("error", () => response.destroy());
    content.stream.pipe(response);
  }

  @Put("jobs/:jobId/output")
  async output(
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Headers("x-hahatalk-ai-worker-token") token: string | undefined,
    @Headers("x-hahatalk-ai-worker-id") workerId: string | undefined,
    @Headers("x-hahatalk-ai-fencing-token") rawFencingToken: string | undefined,
    @Headers("x-hahatalk-file-name") rawFileName: string | undefined,
    @Headers("content-type") mimeType: string | undefined,
    @Req() request: Request
  ) {
    this.ai.assertWorkerToken(token);
    const fileName = rawFileName ? decodeURIComponent(rawFileName) : "ai-output.bin";
    return this.ai.ingestWorkerOutput(
      jobId,
      workerId ?? "",
      this.fencingToken(rawFencingToken),
      fileName,
      mimeType ?? "application/octet-stream",
      request
    );
  }

  private fencingToken(raw: string | undefined) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new ConflictException("AI fencing token is invalid.");
    return value;
  }
}
