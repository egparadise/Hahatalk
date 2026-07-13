import { Global, Module } from "@nestjs/common";
import { LiveKitEgressProviderService } from "./livekit-egress-provider.service.js";
import { RecordingsController } from "./recordings.controller.js";
import { RecordingsService } from "./recordings.service.js";

@Global()
@Module({
  controllers: [RecordingsController],
  exports: [LiveKitEgressProviderService, RecordingsService],
  providers: [LiveKitEgressProviderService, RecordingsService]
})
export class RecordingsModule {}
