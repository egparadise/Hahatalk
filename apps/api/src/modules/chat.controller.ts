import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { type AudienceType } from "@hahatalk/contracts";
import { DemoStore } from "./demo-store.js";

class SendMessageDto {
  senderId = "user-you";
  body = "";
  audienceType: AudienceType = "all";
  targetUserIds: string[] = [];
  requiresConfirmation = false;
}

class CreateInviteDto {
  email = "";
  role: "member" | "guest" = "guest";
  invitedBy = "user-you";
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
