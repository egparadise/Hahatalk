import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { InvitationModule } from "./invitations/invitation.module.js";
import { ChatModule } from "./modules/chat.module.js";
import { ContactsModule } from "./contacts/contacts.module.js";
import { MediaModule } from "./media/media.module.js";
import { CalendarModule } from "./calendar/calendar.module.js";
import { CallsModule } from "./calls/calls.module.js";
import { MeetingsModule } from "./meetings/meetings.module.js";
import { RecordingsModule } from "./recordings/recordings.module.js";
import { BroadcastsModule } from "./broadcasts/broadcasts.module.js";

@Module({
  imports: [
    ThrottlerModule.forRoot([{ limit: 120, ttl: 60_000 }]),
    DatabaseModule,
    AuthModule,
    InvitationModule,
    ContactsModule,
    ChatModule,
    MediaModule,
    CalendarModule,
    RecordingsModule,
    CallsModule,
    MeetingsModule,
    BroadcastsModule
  ]
})
export class AppModule {}
