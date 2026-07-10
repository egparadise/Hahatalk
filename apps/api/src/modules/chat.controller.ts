import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import {
  type ApprovalPolicy,
  type AudienceType,
  type ConfirmMessageReadInput,
  type CreateAttachmentMessageInput,
  type CreateInviteInput,
  type MemberRole,
  type SendMessageInput
} from "@hahatalk/contracts";
import { IsArray, IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from "class-validator";
import { DemoStore } from "./demo-store.js";

class SendMessageDto {
  @IsString()
  senderId = "user-you";

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

  @IsString()
  invitedBy = "user-you";

  @IsOptional()
  @IsIn(["owner_and_invitee", "admins_and_invitee", "all_members_and_invitee", "quorum_and_invitee"])
  approvalPolicy?: ApprovalPolicy;
}

class CreateAttachmentMessageDto {
  @IsString()
  uploaderId = "user-you";

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

class SignupDto {
  @IsString()
  @MinLength(2)
  displayName = "";

  @IsEmail()
  email = "";

  @IsString()
  characterId = "char-calm-lead";

  @IsOptional()
  @IsString()
  inviteCode?: string;
}

class LoginDto {
  @IsEmail()
  email = "";
}

class ConfirmMessageReadDto {
  @IsString()
  userId = "user-you";
}

@Controller()
export class ChatController {
  constructor(@Inject(DemoStore) private readonly store: DemoStore) {}

  @Get("health")
  health() {
    return {
      ok: true,
      service: "hahatalk-api",
      timestamp: new Date().toISOString()
    };
  }

  @Get("mvp")
  mvpSnapshot(@Query("viewerId") viewerId?: string) {
    return this.store.snapshot(viewerId || "user-you");
  }

  @Get("spaces/:spaceId/view")
  conversationView(@Param("spaceId") spaceId: string, @Query("viewerId") viewerId?: string) {
    return this.store.conversationView(viewerId || "user-you", spaceId);
  }

  @Post("auth/signup")
  signup(@Body() body: SignupDto) {
    return this.store.signup(body);
  }

  @Post("auth/login")
  login(@Body() body: LoginDto) {
    return this.store.login(body);
  }

  @Post("messages")
  sendMessage(@Body() body: SendMessageDto) {
    return this.store.sendMessage(body as SendMessageInput);
  }

  @Get("messages/:messageId/read-report")
  readReport(@Param("messageId") messageId: string, @Query("viewerId") viewerId?: string) {
    return this.store.readReport(messageId, viewerId || "user-you");
  }

  @Post("messages/:messageId/confirm")
  confirmRead(@Param("messageId") messageId: string, @Body() body: ConfirmMessageReadDto) {
    return this.store.confirmRead(messageId, body as ConfirmMessageReadInput);
  }

  @Post("invites")
  createInvite(@Body() body: CreateInviteDto) {
    return this.store.createInvite(body as CreateInviteInput);
  }

  @Post("attachments")
  createAttachmentMessage(@Body() body: CreateAttachmentMessageDto) {
    return this.store.createAttachmentMessage(body as CreateAttachmentMessageInput);
  }
}
