import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException
} from "@nestjs/websockets";
import type { AudienceType, MemberRole, SendConversationMessageInput } from "@hahatalk/contracts";
import { Server, Socket } from "socket.io";
import { AuthService } from "../auth/auth.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { ConversationService } from "./conversation.service.js";
import { RealtimeDeliveryService } from "./realtime-delivery.service.js";

interface JoinRoomEvent {
  spaceId?: string;
  before?: string;
  limit?: number;
}

interface SendMessageEvent {
  spaceId: string;
  clientMessageId: string;
  body: string;
  audienceType: AudienceType;
  targetUserIds?: string[];
  targetRole?: MemberRole;
  parentMessageId?: string;
  requiresConfirmation?: boolean;
}

interface TypingEvent {
  spaceId: string;
  active: boolean;
  targetUserIds?: string[];
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
    private readonly conversations: ConversationService,
    private readonly authService: AuthService,
    private readonly realtime: RealtimeDeliveryService
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
    server.use(async (socket, next) => {
      try {
        const cookiePrincipal = await this.authService.authenticateCookieHeader(socket.handshake.headers.cookie);
        const mobileAccessToken = typeof socket.handshake.auth?.accessToken === "string"
          ? socket.handshake.auth.accessToken
          : undefined;
        const principal = cookiePrincipal
          ?? (mobileAccessToken?.startsWith("hha_")
            ? await this.authService.authenticateMobileToken(mobileAccessToken)
            : undefined);
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
  async joinRoom(@ConnectedSocket() socket: Socket, @MessageBody() body?: JoinRoomEvent) {
    try {
      const principal = this.principal(socket);
      const userId = principal.state.user.id;
      const userRoom = this.realtime.userRoom(userId);
      await socket.join(userRoom);
      socket.data.userId = userId;
      const snapshot = await this.conversations.snapshot(principal, body?.spaceId, body?.before, body?.limit);
      socket.emit("room:snapshot", snapshot);
      this.logger.log(`socket ${socket.id} joined ${userRoom}`);
      return snapshot;
    } catch (error) {
      throw this.websocketError(error);
    }
  }

  @SubscribeMessage("message:send")
  async sendMessage(@ConnectedSocket() socket: Socket, @MessageBody() body: SendMessageEvent) {
    try {
      if (!body) {
        throw new Error("Message payload is required.");
      }
      const input: SendConversationMessageInput = {
        spaceId: body.spaceId,
        clientMessageId: body.clientMessageId,
        body: body.body,
        audienceType: body.audienceType,
        targetUserIds: body.targetUserIds ?? [],
        ...(body.targetRole ? { targetRole: body.targetRole } : {}),
        ...(body.parentMessageId ? { parentMessageId: body.parentMessageId } : {}),
        ...(body.requiresConfirmation !== undefined ? { requiresConfirmation: body.requiresConfirmation } : {})
      };
      return await this.conversations.sendMessage(this.principal(socket), input);
    } catch (error) {
      throw this.websocketError(error);
    }
  }

  @SubscribeMessage("typing:set")
  async setTyping(@ConnectedSocket() socket: Socket, @MessageBody() body: TypingEvent) {
    try {
      if (!body || typeof body.active !== "boolean") {
        throw new Error("Typing payload is invalid.");
      }
      const principal = this.principal(socket);
      const recipients = await this.conversations.typingRecipients(principal, body.spaceId, body.targetUserIds);
      const update = this.conversations.typingUpdate(principal, body.spaceId, body.active);
      for (const userId of recipients) {
        this.realtime.emitToUser(userId, "typing:updated", update);
      }
      return update;
    } catch (error) {
      throw this.websocketError(error);
    }
  }

  private principal(socket: Socket) {
    const principal = socket.data.auth as AuthPrincipal | undefined;
    if (!principal) {
      throw new Error("Authentication required.");
    }
    return principal;
  }

  private websocketError(error: unknown) {
    return new WsException(error instanceof Error ? error.message : "Realtime request failed.");
  }
}
