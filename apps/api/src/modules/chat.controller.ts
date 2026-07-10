import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query
} from "@nestjs/common";
import {
  type AudienceType,
  type CreateAttachmentMessageInput,
  type MemberRole,
  type SendConversationMessageInput
} from "@hahatalk/contracts";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import { CurrentAuth, PublicRoute } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";
import { ConversationService } from "./conversation.service.js";
import { DemoStore } from "./demo-store.js";

class SendMessageDto {
  @IsUUID()
  spaceId = "";

  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientMessageId = "";

  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body = "";

  @IsIn(["all", "selected", "private", "role"])
  audienceType: AudienceType = "all";

  @IsArray()
  @IsString({ each: true })
  targetUserIds: string[] = [];

  @IsOptional()
  @IsIn(["owner", "admin", "member", "guest", "subscriber"])
  targetRole?: MemberRole;

  @IsOptional()
  @IsUUID()
  parentMessageId?: string;

  @IsBoolean()
  requiresConfirmation = false;
}

class EditMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body = "";
}

class CreateAttachmentMessageDto {
  @IsString()
  @MinLength(1)
  fileName = "";

  @IsString()
  mimeType = "application/octet-stream";

  @IsNumber()
  @Min(1)
  sizeBytes = 0;

  @IsIn(["all", "selected", "private", "role"])
  audienceType: AudienceType = "all";

  @IsArray()
  @IsString({ each: true })
  targetUserIds: string[] = [];

  @IsOptional()
  @IsIn(["owner", "admin", "member", "guest", "subscriber"])
  targetRole?: MemberRole;

  @IsIn(["file_upload", "screen_capture"])
  source: "file_upload" | "screen_capture" = "file_upload";

  @IsOptional()
  @IsIn(["private_archive", "shared", "selected"])
  mediaVisibility?: "private_archive" | "shared" | "selected";
}

@Controller()
export class ChatController {
  constructor(
    private readonly conversations: ConversationService,
    @Inject(DemoStore) private readonly store: DemoStore,
    private readonly database: DatabaseService
  ) {}

  @PublicRoute()
  @Get("health")
  async health() {
    return {
      database: await this.database.health(),
      ok: true,
      service: "hahatalk-api",
      timestamp: new Date().toISOString()
    };
  }

  @Get("mvp")
  mvpSnapshot(
    @CurrentAuth() principal: AuthPrincipal,
    @Query("spaceId") spaceId?: string,
    @Query("before") before?: string,
    @Query("limit") rawLimit?: string
  ) {
    return this.conversations.snapshot(principal, spaceId, before, this.parseLimit(rawLimit));
  }

  @Get("spaces")
  listSpaces(@CurrentAuth() principal: AuthPrincipal) {
    return this.conversations.listSpaces(principal);
  }

  @Get("spaces/:spaceId/view")
  conversationView(
    @Param("spaceId", ParseUUIDPipe) spaceId: string,
    @CurrentAuth() principal: AuthPrincipal,
    @Query("before") before?: string,
    @Query("limit") rawLimit?: string
  ) {
    return this.conversations.conversationView(principal, spaceId, before, this.parseLimit(rawLimit));
  }

  @Get("spaces/:spaceId/search")
  search(
    @Param("spaceId", ParseUUIDPipe) spaceId: string,
    @Query("q") query: string,
    @CurrentAuth() principal: AuthPrincipal,
    @Query("limit") rawLimit?: string
  ) {
    return this.conversations.search(principal, spaceId, query ?? "", this.parseLimit(rawLimit));
  }

  @Post("messages")
  sendMessage(@Body() body: SendMessageDto, @CurrentAuth() principal: AuthPrincipal) {
    const input: SendConversationMessageInput = {
      spaceId: body.spaceId,
      clientMessageId: body.clientMessageId,
      body: body.body,
      audienceType: body.audienceType,
      targetUserIds: body.targetUserIds,
      ...(body.targetRole ? { targetRole: body.targetRole } : {}),
      ...(body.parentMessageId ? { parentMessageId: body.parentMessageId } : {}),
      requiresConfirmation: body.requiresConfirmation
    };
    return this.conversations.sendMessage(principal, input);
  }

  @Patch("messages/:messageId")
  editMessage(
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @Body() body: EditMessageDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.conversations.editMessage(principal, messageId, body.body);
  }

  @Delete("messages/:messageId")
  deleteMessage(
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.conversations.deleteMessage(principal, messageId);
  }

  @Post("messages/:messageId/read")
  markRead(
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.conversations.markRead(principal, messageId, false);
  }

  @Get("messages/:messageId/read-report")
  readReport(
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.conversations.readReport(principal, messageId);
  }

  @Post("messages/:messageId/confirm")
  confirmRead(
    @Param("messageId", ParseUUIDPipe) messageId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.conversations.markRead(principal, messageId, true);
  }

  @Post("attachments")
  createAttachmentMessage(@Body() body: CreateAttachmentMessageDto, @CurrentAuth() principal: AuthPrincipal) {
    if (!principal.state.permissions.canUploadFiles) {
      throw new ForbiddenException("File upload permission is required.");
    }
    this.store.ensureUser(principal.state.user, principal.state.role);
    const uploaderId = principal.state.user.id;
    return this.store.createAttachmentMessage({ ...body, uploaderId } as CreateAttachmentMessageInput);
  }

  private parseLimit(rawLimit?: string) {
    if (rawLimit === undefined || rawLimit === "") {
      return undefined;
    }
    const value = Number(rawLimit);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new BadRequestException("Page limit must be an integer between 1 and 100.");
    }
    return value;
  }
}
