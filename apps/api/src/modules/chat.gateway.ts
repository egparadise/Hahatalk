import { Inject, Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { type AudienceType } from "@hahatalk/contracts";
import { DemoStore } from "./demo-store.js";

interface SendMessageEvent {
  senderId: string;
  body: string;
  audienceType: AudienceType;
  targetUserIds: string[];
  requiresConfirmation?: boolean;
}

interface JoinRoomEvent {
  userId: string;
}

@WebSocketGateway({
  cors: {
    origin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000",
    credentials: true
  }
})
export class ChatGateway {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(@Inject(DemoStore) private readonly store: DemoStore) {}

  @SubscribeMessage("room:join")
  joinRoom(@ConnectedSocket() socket: Socket, @MessageBody() body: JoinRoomEvent) {
    const userId = body.userId;
    const userRoom = this.userRoom(userId);
    const snapshot = this.store.snapshot(userId);

    socket.data.userId = userId;
    void socket.join(userRoom);
    socket.emit("room:snapshot", snapshot);
    this.logger.log(`socket ${socket.id} joined ${userRoom}`);
  }

  @SubscribeMessage("message:send")
  sendMessage(@MessageBody() body: SendMessageEvent) {
    const message = this.store.sendMessage(body);

    for (const delivery of message.deliveries) {
      const projectedMessage = this.store.messageForViewer(message.id, delivery.recipientId);

      if (projectedMessage) {
        this.server.to(this.userRoom(delivery.recipientId)).emit("message:created", projectedMessage);
      }
    }

    return this.store.messageForViewer(message.id, body.senderId);
  }

  private userRoom(userId: string) {
    return `user:${userId}`;
  }
}
