import { Module } from "@nestjs/common";
import { ChatController } from "./chat.controller.js";
import { ChatGateway } from "./chat.gateway.js";
import { DemoStore } from "./demo-store.js";

@Module({
  controllers: [ChatController],
  providers: [DemoStore, ChatGateway]
})
export class ChatModule {}

