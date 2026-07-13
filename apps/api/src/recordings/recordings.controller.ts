import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  RawBody,
  UnauthorizedException,
  UseGuards
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { IsIn, IsString, MaxLength } from "class-validator";
import type {
  RecordingConsentDecision,
  RecordingConsentInput,
  RecordingStopReason,
  StopRecordingInput
} from "@hahatalk/contracts";
import { CurrentAuth, PublicRoute } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { LiveKitEgressProviderService } from "./livekit-egress-provider.service.js";
import { RecordingsService } from "./recordings.service.js";

class RecordingConsentDto implements RecordingConsentInput {
  @IsIn(["granted", "denied"])
  decision!: RecordingConsentDecision;

  @IsString()
  @MaxLength(80)
  policyVersion!: string;
}

class StopRecordingDto implements StopRecordingInput {
  @IsIn(["host_stopped", "consent_revoked"])
  reason!: Extract<RecordingStopReason, "host_stopped" | "consent_revoked">;
}

@Controller()
@UseGuards(ThrottlerGuard)
export class RecordingsController {
  constructor(
    private readonly recordings: RecordingsService,
    private readonly provider: LiveKitEgressProviderService
  ) {}

  @Post("calls/:sessionId/recording/request")
  @HttpCode(HttpStatus.OK)
  requestCall(@Param("sessionId", ParseUUIDPipe) id: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.recordings.request(principal, id, "ad_hoc");
  }

  @Post("calls/:sessionId/recording/consent")
  @HttpCode(HttpStatus.OK)
  respondCall(
    @Param("sessionId", ParseUUIDPipe) id: string,
    @Body() body: RecordingConsentDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.recordings.respond(principal, id, "ad_hoc", body.decision, body.policyVersion);
  }

  @Post("calls/:sessionId/recording/start")
  @HttpCode(HttpStatus.OK)
  startCall(@Param("sessionId", ParseUUIDPipe) id: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.recordings.start(principal, id, "ad_hoc");
  }

  @Post("calls/:sessionId/recording/stop")
  @HttpCode(HttpStatus.OK)
  stopCall(
    @Param("sessionId", ParseUUIDPipe) id: string,
    @Body() body: StopRecordingDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.recordings.stop(principal, id, "ad_hoc", body.reason);
  }

  @Post("meetings/:sessionId/recording/request")
  @HttpCode(HttpStatus.OK)
  requestMeeting(@Param("sessionId", ParseUUIDPipe) id: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.recordings.request(principal, id, "scheduled_meeting");
  }

  @Post("meetings/:sessionId/recording/consent")
  @HttpCode(HttpStatus.OK)
  respondMeeting(
    @Param("sessionId", ParseUUIDPipe) id: string,
    @Body() body: RecordingConsentDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.recordings.respond(principal, id, "scheduled_meeting", body.decision, body.policyVersion);
  }

  @Post("meetings/:sessionId/recording/start")
  @HttpCode(HttpStatus.OK)
  startMeeting(@Param("sessionId", ParseUUIDPipe) id: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.recordings.start(principal, id, "scheduled_meeting");
  }

  @Post("meetings/:sessionId/recording/stop")
  @HttpCode(HttpStatus.OK)
  stopMeeting(
    @Param("sessionId", ParseUUIDPipe) id: string,
    @Body() body: StopRecordingDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.recordings.stop(principal, id, "scheduled_meeting", body.reason);
  }

  @PublicRoute()
  @Post("provider/livekit/webhook")
  @HttpCode(HttpStatus.NO_CONTENT)
  async webhook(@RawBody() rawBody: Buffer | undefined, @Headers("authorization") authorization?: string) {
    if (!rawBody || !authorization) throw new UnauthorizedException("LiveKit webhook authentication failed.");
    let event;
    try {
      event = await this.provider.receiveWebhook(rawBody.toString("utf8"), authorization);
    } catch {
      throw new UnauthorizedException("LiveKit webhook authentication failed.");
    }
    if (event.event.startsWith("egress_") && event.egressInfo) {
      await this.recordings.handleProviderState(this.provider.mapInfo(event.egressInfo));
    }
  }
}
