import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ChatController } from "./chat.controller.js";
import { ChatGateway } from "./chat.gateway.js";
import { ConversationService } from "./conversation.service.js";
import { DemoStore } from "./demo-store.js";
import { OutboxPublisherService } from "./outbox-publisher.service.js";
import { RealtimeDeliveryService } from "./realtime-delivery.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ChatController],
  providers: [
    DemoStore,
    ConversationService,
    RealtimeDeliveryService,
    OutboxPublisherService,
    ChatGateway
  ]
})
export class ChatModule {}
