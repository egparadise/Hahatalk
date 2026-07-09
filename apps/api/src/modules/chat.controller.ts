import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import {
  type AudienceType,
  type ConfirmMessageReadInput,
  type CreateAttachmentMessageInput,
  type CreateInviteInput,
  type SendMessageInput
} from "@hahatalk/contracts";
import { IsEmail, IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from "class-validator";
import { DemoStore } from "./demo-store.js";

class SendMessageDto {
  @IsString()
  senderId = "user-you";

  @IsString()
  @MinLength(1)
  body = "";

  @IsIn(["all", "selected", "private", "role"])
  audienceType: AudienceType = "all";

  targetUserIds: string[] = [];

  requiresConfirmation = false;
}

class CreateInviteDto {
  @IsEmail()
  email = "";

  @IsIn(["member", "guest"])
  role: "member" | "guest" = "guest";

  @IsString()
  invitedBy = "user-you";
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

  targetUserIds: string[] = [];

  @IsIn(["file_upload", "screen_capture"])
  source: "file_upload" | "screen_capture" = "file_upload";
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
  mvpSnapshot() {
    return this.store.snapshot();
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
  readReport(@Param("messageId") messageId: string) {
    return this.store.readReport(messageId);
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
