import { Inject, Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { type AudienceType } from "@hahatalk/contracts";
import { AuthService } from "../auth/auth.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DemoStore } from "./demo-store.js";

interface SendMessageEvent {
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
export class ChatGateway implements OnGatewayInit {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    @Inject(DemoStore) private readonly store: DemoStore,
    private readonly authService: AuthService
  ) {}

  afterInit(server: Server) {
    server.use(async (socket, next) => {
      try {
        const principal = await this.authService.authenticateCookieHeader(socket.handshake.headers.cookie);
        if (!principal) {
          next(new Error("Authentication required."));
          return;
        }
        socket.data.auth = principal;
        next();
      } catch {
        next(new Error("Authentication required."));
      }
    });
  }

  @SubscribeMessage("room:join")
  joinRoom(@ConnectedSocket() socket: Socket) {
    const principal = this.principal(socket);
    const userId = principal.state.user.id;
    this.store.ensureUser(principal.state.user, principal.state.role);
    const userRoom = this.userRoom(userId);
    const snapshot = this.store.snapshot(userId);

    socket.data.userId = userId;
    void socket.join(userRoom);
    socket.emit("room:snapshot", snapshot);
    this.logger.log(`socket ${socket.id} joined ${userRoom}`);
  }

  @SubscribeMessage("message:send")
  sendMessage(@ConnectedSocket() socket: Socket, @MessageBody() body: SendMessageEvent) {
    const principal = this.principal(socket);
    const senderId = principal.state.user.id;
    this.store.ensureUser(principal.state.user, principal.state.role);
    const message = this.store.sendMessage({ ...body, senderId });

    for (const delivery of message.deliveries) {
      const projectedMessage = this.store.messageForViewer(message.id, delivery.recipientId);

      if (projectedMessage) {
        this.server.to(this.userRoom(delivery.recipientId)).emit("message:created", projectedMessage);
      }
    }

    return this.store.messageForViewer(message.id, senderId);
  }

  private principal(socket: Socket) {
    const principal = socket.data.auth as AuthPrincipal | undefined;
    if (!principal) {
      throw new Error("Authentication required.");
    }
    return principal;
  }

  private userRoom(userId: string) {
    return `user:${userId}`;
  }
}
