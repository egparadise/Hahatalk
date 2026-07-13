import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { ArrayMaxSize, IsArray, IsIn, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import type { CallType, StartCallInput } from "@hahatalk/contracts";
import { CurrentAuth } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { CallsService } from "./calls.service.js";

class StartCallDto implements StartCallInput {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientCallId = "";

  @IsUUID()
  spaceId = "";

  @IsIn(["voice", "video"])
  callType: CallType = "voice";

  @IsArray()
  @ArrayMaxSize(15)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  targetUserIds: string[] = [];
}

@Controller("calls")
@UseGuards(ThrottlerGuard)
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get("capabilities")
  capabilities() {
    return this.calls.capabilities();
  }

  @Get()
  list(@Query("spaceId", ParseUUIDPipe) spaceId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.calls.list(principal, spaceId);
  }

  @Get(":callId")
  get(@Param("callId", ParseUUIDPipe) callId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.calls.get(principal, callId);
  }

  @Post()
  start(@Body() body: StartCallDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.calls.start(principal, body);
  }

  @Post(":callId/join")
  @HttpCode(HttpStatus.OK)
  join(@Param("callId", ParseUUIDPipe) callId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.calls.join(principal, callId);
  }

  @Post(":callId/connected")
  @HttpCode(HttpStatus.OK)
  connected(@Param("callId", ParseUUIDPipe) callId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.calls.connected(principal, callId);
  }

  @Post(":callId/decline")
  @HttpCode(HttpStatus.OK)
  decline(@Param("callId", ParseUUIDPipe) callId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.calls.decline(principal, callId);
  }

  @Post(":callId/leave")
  @HttpCode(HttpStatus.OK)
  leave(@Param("callId", ParseUUIDPipe) callId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.calls.leave(principal, callId);
  }

  @Post(":callId/end")
  @HttpCode(HttpStatus.OK)
  end(@Param("callId", ParseUUIDPipe) callId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.calls.end(principal, callId);
  }
}
