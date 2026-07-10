import { Body, Controller, ForbiddenException, Get, Inject, Param, Post } from "@nestjs/common";
import {
  type ApprovalPolicy,
  type AudienceType,
  type CreateAttachmentMessageInput,
  type CreateInviteInput,
  type MemberRole,
  type SendMessageInput
} from "@hahatalk/contracts";
import { IsArray, IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from "class-validator";
import { CurrentAuth, PublicRoute } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";
import { DemoStore } from "./demo-store.js";

class SendMessageDto {
  @IsString()
  @MinLength(1)
  body = "";

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

class CreateInviteDto {
  @IsEmail()
  email = "";

  @IsIn(["member", "guest"])
  role: "member" | "guest" = "guest";

  @IsOptional()
  @IsIn(["owner_and_invitee", "admins_and_invitee", "all_members_and_invitee", "quorum_and_invitee"])
  approvalPolicy?: ApprovalPolicy;
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
  mvpSnapshot(@CurrentAuth() principal: AuthPrincipal) {
    const viewerId = this.ensureViewer(principal);
    return this.store.snapshot(viewerId);
  }

  @Get("spaces/:spaceId/view")
  conversationView(@Param("spaceId") spaceId: string, @CurrentAuth() principal: AuthPrincipal) {
    const viewerId = this.ensureViewer(principal);
    return this.store.conversationView(viewerId, spaceId);
  }

  @Post("messages")
  sendMessage(@Body() body: SendMessageDto, @CurrentAuth() principal: AuthPrincipal) {
    const senderId = this.ensureViewer(principal);
    return this.store.sendMessage({ ...body, senderId } as SendMessageInput);
  }

  @Get("messages/:messageId/read-report")
  readReport(@Param("messageId") messageId: string, @CurrentAuth() principal: AuthPrincipal) {
    if (!principal.state.permissions.canOpenReadReport) {
      throw new ForbiddenException("Read report permission is required.");
    }
    const viewerId = this.ensureViewer(principal);
    return this.store.readReport(messageId, viewerId);
  }

  @Post("messages/:messageId/confirm")
  confirmRead(@Param("messageId") messageId: string, @CurrentAuth() principal: AuthPrincipal) {
    const userId = this.ensureViewer(principal);
    return this.store.confirmRead(messageId, { userId });
  }

  @Post("invites")
  createInvite(@Body() body: CreateInviteDto, @CurrentAuth() principal: AuthPrincipal) {
    if (!principal.state.permissions.canInviteGuests) {
      throw new ForbiddenException("Guest invitation permission is required.");
    }
    const invitedBy = this.ensureViewer(principal);
    return this.store.createInvite({ ...body, invitedBy } as CreateInviteInput);
  }

  @Post("attachments")
  createAttachmentMessage(@Body() body: CreateAttachmentMessageDto, @CurrentAuth() principal: AuthPrincipal) {
    if (!principal.state.permissions.canUploadFiles) {
      throw new ForbiddenException("File upload permission is required.");
    }
    const uploaderId = this.ensureViewer(principal);
    return this.store.createAttachmentMessage({ ...body, uploaderId } as CreateAttachmentMessageInput);
  }

  private ensureViewer(principal: AuthPrincipal) {
    this.store.ensureUser(principal.state.user, principal.state.role);
    return principal.state.user.id;
  }
}
