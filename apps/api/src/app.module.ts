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
import { AiModule } from "./ai/ai.module.js";
import { RemoteSupportModule } from "./remote-support/remote-support.module.js";
import { MobileModule } from "./mobile/mobile.module.js";
import { OperationsModule } from "./operations/operations.module.js";
import { createThrottleTracker, PostgresThrottlerStorage } from "./security/postgres-throttler-storage.js";
import { SecurityModule } from "./security/security.module.js";

@Module({
  imports: [
    DatabaseModule,
    SecurityModule,
    ThrottlerModule.forRootAsync({
      imports: [SecurityModule],
      inject: [PostgresThrottlerStorage],
      useFactory: (storage: PostgresThrottlerStorage) => ({
        getTracker: createThrottleTracker,
        storage,
        throttlers: [{ blockDuration: 60_000, limit: 120, name: "default", ttl: 60_000 }]
      })
    }),
    AuthModule,
    InvitationModule,
    ContactsModule,
    ChatModule,
    MediaModule,
    CalendarModule,
    RecordingsModule,
    CallsModule,
    MeetingsModule,
    BroadcastsModule,
    AiModule,
    RemoteSupportModule,
    MobileModule,
    OperationsModule
  ]
})
export class AppModule {}
