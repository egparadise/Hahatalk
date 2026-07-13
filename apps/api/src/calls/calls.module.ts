import { Module } from "@nestjs/common";
import { CallsController } from "./calls.controller.js";
import { CallsService } from "./calls.service.js";
import { LiveKitProviderService } from "./livekit-provider.service.js";

@Module({
  controllers: [CallsController],
  providers: [CallsService, LiveKitProviderService]
})
export class CallsModule {}
