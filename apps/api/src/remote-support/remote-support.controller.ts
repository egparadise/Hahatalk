import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength
} from "class-validator";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type {
  CreateRemoteSupportInput,
  DecideRemoteSupportConsentInput,
  RemoteSupportCommandInput,
  RemoteSupportCommandKind,
  RemoteSupportScope
} from "@hahatalk/contracts";
import { CurrentAuth, PublicRoute } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { RemoteSupportService } from "./remote-support.service.js";

class CreateRemoteSupportDto implements CreateRemoteSupportInput {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientRequestId = "";

  @IsUUID()
  spaceId = "";

  @IsUUID()
  callId = "";

  @IsString()
  @MinLength(3)
  @MaxLength(80)
  targetUserId = "";

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsIn(["screen_view", "remote_control", "clipboard", "file_transfer"], { each: true })
  requestedScopes: RemoteSupportScope[] = [];
}

class DecideRemoteSupportConsentDto implements DecideRemoteSupportConsentInput {
  @IsIn(["screen_view", "remote_control", "clipboard", "file_transfer"])
  scope: RemoteSupportScope = "screen_view";

  @IsIn(["granted", "denied"])
  decision: "granted" | "denied" = "denied";

  @IsString()
  @MinLength(8)
  @MaxLength(80)
  policyVersion = "";
}

class RemoteSupportCommandDto {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientCommandId = "";

  @IsIn(["pointer_move", "pointer_button", "wheel", "key"])
  kind: RemoteSupportCommandKind = "pointer_move";

  @IsObject()
  payload: Record<string, unknown> = {};
}

class ActivateRemoteSupportAgentDto {
  @IsString()
  @MinLength(32)
  @MaxLength(200)
  activationSecret = "";

  @IsString()
  @MinLength(8)
  @MaxLength(160)
  agentInstanceId = "";

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  agentVersion = "";

  @IsString()
  @MinLength(8)
  @MaxLength(160)
  deviceId = "";

  @IsString()
  @MinLength(3)
  @MaxLength(40)
  platform = "";
}

class CompleteRemoteSupportCommandDto {
  @IsIn(["executed", "simulated", "rejected"])
  outcome: "executed" | "simulated" | "rejected" = "rejected";

  @IsOptional()
  @IsString()
  @MaxLength(120)
  resultCode?: string;
}

@Controller("remote-support")
@UseGuards(ThrottlerGuard)
export class RemoteSupportController {
  constructor(private readonly remoteSupport: RemoteSupportService) {}

  @Get("capabilities")
  capabilities() {
    return this.remoteSupport.capabilities();
  }

  @Get()
  list(
    @Query("spaceId", new ParseUUIDPipe({ optional: true })) spaceId: string | undefined,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.remoteSupport.list(principal, spaceId);
  }

  @Get(":sessionId")
  get(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.remoteSupport.get(principal, sessionId);
  }

  @Post()
  create(@Body() body: CreateRemoteSupportDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.remoteSupport.create(principal, body);
  }

  @Post(":sessionId/consents")
  @HttpCode(HttpStatus.OK)
  decide(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Body() body: DecideRemoteSupportConsentDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.remoteSupport.decide(principal, sessionId, body);
  }

  @Post(":sessionId/agent-activation")
  createAgentActivation(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.remoteSupport.createAgentActivation(principal, sessionId);
  }

  @Post(":sessionId/commands")
  sendCommand(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Body() body: RemoteSupportCommandDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.remoteSupport.sendCommand(principal, sessionId, body as RemoteSupportCommandInput);
  }

  @Post(":sessionId/pause")
  @HttpCode(HttpStatus.OK)
  pause(@Param("sessionId", ParseUUIDPipe) sessionId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.remoteSupport.pause(principal, sessionId);
  }

  @Post(":sessionId/resume")
  @HttpCode(HttpStatus.OK)
  resume(@Param("sessionId", ParseUUIDPipe) sessionId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.remoteSupport.resume(principal, sessionId);
  }

  @Post(":sessionId/revoke")
  @HttpCode(HttpStatus.OK)
  revoke(@Param("sessionId", ParseUUIDPipe) sessionId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.remoteSupport.revoke(principal, sessionId);
  }

  @Post(":sessionId/emergency-stop")
  @HttpCode(HttpStatus.OK)
  emergencyStop(@Param("sessionId", ParseUUIDPipe) sessionId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.remoteSupport.emergencyStop(principal, sessionId);
  }

  @Post(":sessionId/end")
  @HttpCode(HttpStatus.OK)
  end(@Param("sessionId", ParseUUIDPipe) sessionId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.remoteSupport.end(principal, sessionId);
  }
}

@PublicRoute()
@Controller("internal/remote-support")
@UseGuards(ThrottlerGuard)
export class RemoteSupportAgentController {
  constructor(private readonly remoteSupport: RemoteSupportService) {}

  @Post("activate")
  activate(@Body() body: ActivateRemoteSupportAgentDto) {
    return this.remoteSupport.activateAgent(body);
  }

  @Post("sessions/:sessionId/heartbeat")
  @HttpCode(HttpStatus.OK)
  heartbeat(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Headers("x-hahatalk-remote-agent-token") token: string | undefined
  ) {
    return this.remoteSupport.agentHeartbeat(sessionId, token);
  }

  @Post("sessions/:sessionId/commands/claim")
  @HttpCode(HttpStatus.OK)
  claim(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Headers("x-hahatalk-remote-agent-token") token: string | undefined
  ) {
    return this.remoteSupport.agentClaimCommands(sessionId, token);
  }

  @Post("sessions/:sessionId/commands/:commandId/complete")
  @HttpCode(HttpStatus.OK)
  complete(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Param("commandId", ParseUUIDPipe) commandId: string,
    @Headers("x-hahatalk-remote-agent-token") token: string | undefined,
    @Body() body: CompleteRemoteSupportCommandDto
  ) {
    return this.remoteSupport.agentCompleteCommand(
      sessionId,
      commandId,
      token,
      body.outcome,
      body.resultCode
    );
  }
}
