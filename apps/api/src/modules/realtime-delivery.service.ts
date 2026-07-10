import { Injectable } from "@nestjs/common";
import type { Server } from "socket.io";

@Injectable()
export class RealtimeDeliveryService {
  private server?: Server;

  attach(server: Server) {
    this.server = server;
  }

  get ready() {
    return Boolean(this.server);
  }

  emitToUser(userId: string, event: string, payload: unknown) {
    if (!this.server) {
      return false;
    }
    this.server.to(this.userRoom(userId)).emit(event, payload);
    return true;
  }

  userRoom(userId: string) {
    return `user:${userId}`;
  }
}
