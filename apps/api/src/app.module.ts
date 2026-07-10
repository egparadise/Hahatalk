import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { InvitationModule } from "./invitations/invitation.module.js";
import { ChatModule } from "./modules/chat.module.js";

@Module({
  imports: [
    ThrottlerModule.forRoot([{ limit: 120, ttl: 60_000 }]),
    DatabaseModule,
    AuthModule,
    InvitationModule,
    ChatModule
  ]
})
export class AppModule {}
