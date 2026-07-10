import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ChatController } from "./chat.controller.js";
import { ChatGateway } from "./chat.gateway.js";
import { DemoStore } from "./demo-store.js";

@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [DemoStore, ChatGateway]
})
export class ChatModule {}
