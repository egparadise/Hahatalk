import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import type {
  BroadcastChatMode,
  BroadcastModerationAction,
  BroadcastNotificationLevel,
  BroadcastReaction,
  BroadcastRole,
  BroadcastChannelVisibility,
  CallType,
  ChangeBroadcastRoleInput,
  CreateBroadcastChannelInput,
  CreateBroadcastMessageInput,
  ModerateBroadcastMessageInput,
  ScheduleBroadcastInput,
  SendBroadcastReactionInput
} from "@hahatalk/contracts";
import { CurrentAuth } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { BroadcastsService } from "./broadcasts.service.js";

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

class CreateChannelDto implements CreateBroadcastChannelInput {
  @Matches(/^[a-z0-9][a-z0-9._-]{2,39}$/)
  handle = "";

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name = "";

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsIn(["organization", "unlisted"])
  visibility: BroadcastChannelVisibility = "organization";
}

class SubscriptionDto {
  @IsIn(["all", "live_only", "off"])
  notificationLevel: BroadcastNotificationLevel = "live_only";
}

class ScheduleBroadcastDto implements ScheduleBroadcastInput {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientSessionId = "";

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title = "";

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsIn(["voice", "video"])
  callType: CallType = "video";

  @IsIn(["disabled", "subscribers", "moderated"])
  chatMode: BroadcastChatMode = "moderated";

  @Matches(instantPattern)
  scheduledFor = "";

  @Matches(instantPattern)
  expectedEndAt = "";

  @IsInt()
  @Min(1)
  @Max(3000)
  viewerLimit = 500;

  @IsBoolean()
  replayRequested = true;
}

class VersionDto {
  @IsInt()
  @Min(1)
  version = 1;
}

class ChangeRoleDto extends VersionDto implements ChangeBroadcastRoleInput {
  @IsIn(["cohost", "speaker", "viewer"])
  role: Exclude<BroadcastRole, "host"> = "viewer";
}

class ModerateParticipantDto {
  @IsIn(["remove", "block", "unblock"])
  action: "remove" | "block" | "unblock" = "remove";
}

class CreateMessageDto implements CreateBroadcastMessageInput {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientMessageId = "";

  @IsIn(["chat", "question", "announcement"])
  kind: CreateBroadcastMessageInput["kind"] = "chat";

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body = "";
}

class ModerateMessageDto implements ModerateBroadcastMessageInput {
  @IsIn(["publish", "hide", "restore", "dismiss"])
  action: BroadcastModerationAction = "publish";

  @IsInt()
  @Min(1)
  version = 1;
}

class ReactionDto implements SendBroadcastReactionInput {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientReactionId = "";

  @IsIn(["like", "applause", "thanks", "question", "celebrate"])
  reaction: BroadcastReaction = "like";
}

@Controller("broadcasts")
@UseGuards(ThrottlerGuard)
export class BroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  @Get("capabilities")
  capabilities() {
    return this.broadcasts.capabilities();
  }

  @Get()
  dashboard(@CurrentAuth() principal: AuthPrincipal) {
    return this.broadcasts.dashboard(principal);
  }

  @Post("channels")
  createChannel(@Body() body: CreateChannelDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.broadcasts.createChannel(principal, body);
  }

  @Post("channels/:channelId/subscribe")
  @HttpCode(HttpStatus.OK)
  subscribe(
    @Param("channelId", ParseUUIDPipe) channelId: string,
    @Body() body: SubscriptionDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.subscribe(principal, channelId, body.notificationLevel);
  }

  @Delete("channels/:channelId/subscription")
  unsubscribe(
    @Param("channelId", ParseUUIDPipe) channelId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.unsubscribe(principal, channelId);
  }

  @Post("channels/:channelId/sessions")
  schedule(
    @Param("channelId", ParseUUIDPipe) channelId: string,
    @Body() body: ScheduleBroadcastDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.schedule(principal, channelId, body);
  }

  @Post("channels/:channelId/private-handoff")
  @HttpCode(HttpStatus.OK)
  privateHandoff(
    @Param("channelId", ParseUUIDPipe) channelId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.privateHandoff(principal, channelId);
  }

  @Get("sessions/:sessionId")
  get(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.get(principal, sessionId);
  }

  @Post("sessions/:sessionId/start")
  @HttpCode(HttpStatus.OK)
  start(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Body() body: VersionDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.start(principal, sessionId, body.version);
  }

  @Post("sessions/:sessionId/join")
  @HttpCode(HttpStatus.OK)
  join(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.join(principal, sessionId);
  }

  @Post("sessions/:sessionId/connected")
  @HttpCode(HttpStatus.OK)
  connected(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.connected(principal, sessionId);
  }

  @Post("sessions/:sessionId/leave")
  @HttpCode(HttpStatus.OK)
  leave(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.leave(principal, sessionId);
  }

  @Post("sessions/:sessionId/end")
  @HttpCode(HttpStatus.OK)
  end(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Body() body: VersionDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.end(principal, sessionId, body.version);
  }

  @Patch("sessions/:sessionId/participants/:userId/role")
  role(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Param("userId") userId: string,
    @Body() body: ChangeRoleDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.changeRole(principal, sessionId, userId, body);
  }

  @Post("sessions/:sessionId/participants/:userId/moderate")
  @HttpCode(HttpStatus.OK)
  moderateParticipant(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Param("userId") userId: string,
    @Body() body: ModerateParticipantDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.moderateParticipant(principal, sessionId, userId, body.action);
  }

  @Post("sessions/:sessionId/messages")
  createMessage(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Body() body: CreateMessageDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.createMessage(principal, sessionId, body);
  }

  @Patch("sessions/:sessionId/messages/:messageId/moderate")
  moderateMessage(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @Body() body: ModerateMessageDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.moderateMessage(principal, sessionId, messageId, body);
  }

  @Post("sessions/:sessionId/reactions")
  react(
    @Param("sessionId", ParseUUIDPipe) sessionId: string,
    @Body() body: ReactionDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.broadcasts.react(principal, sessionId, body);
  }
}
