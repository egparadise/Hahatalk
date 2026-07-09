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
  joinRoom(@ConnectedSocket() socket: Socket) {
    void socket.join("room-smart-sales");
    socket.emit("room:snapshot", this.store.snapshot());
    this.logger.log(`socket ${socket.id} joined room-smart-sales`);
  }

  @SubscribeMessage("message:send")
  sendMessage(@MessageBody() body: SendMessageEvent) {
    const message = this.store.sendMessage(body);
    this.server.to("room-smart-sales").emit("message:created", message);
    return message;
  }
}
