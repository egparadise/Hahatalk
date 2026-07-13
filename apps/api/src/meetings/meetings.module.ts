import { Module } from "@nestjs/common";
import { CallsModule } from "../calls/calls.module.js";
import { MeetingsController } from "./meetings.controller.js";
import { MeetingsService } from "./meetings.service.js";

@Module({
  controllers: [MeetingsController],
  imports: [CallsModule],
  providers: [MeetingsService]
})
export class MeetingsModule {}
