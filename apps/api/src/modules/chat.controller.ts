import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { type AudienceType } from "@hahatalk/contracts";
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from "class-validator";
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
    return this.store.sendMessage(body);
  }

  @Get("messages/:messageId/read-report")
  readReport(@Param("messageId") messageId: string) {
    return this.store.readReport(messageId);
  }

  @Post("invites")
  createInvite(@Body() body: CreateInviteDto) {
    return this.store.createInvite(body);
  }
}
