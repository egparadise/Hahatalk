import { Module } from "@nestjs/common";
import { CallsModule } from "../calls/calls.module.js";
import { BroadcastsController } from "./broadcasts.controller.js";
import { BroadcastsService } from "./broadcasts.service.js";

@Module({
  imports: [CallsModule],
  controllers: [BroadcastsController],
  providers: [BroadcastsService]
})
export class BroadcastsModule {}
