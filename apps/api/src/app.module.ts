import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { InvitationModule } from "./invitations/invitation.module.js";
import { ChatModule } from "./modules/chat.module.js";
import { ContactsModule } from "./contacts/contacts.module.js";
import { MediaModule } from "./media/media.module.js";

@Module({
  imports: [
    ThrottlerModule.forRoot([{ limit: 120, ttl: 60_000 }]),
    DatabaseModule,
    AuthModule,
    InvitationModule,
    ContactsModule,
    ChatModule,
    MediaModule
  ]
})
export class AppModule {}
