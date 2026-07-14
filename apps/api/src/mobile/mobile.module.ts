import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { MobileController, MobilePushWorkerController } from "./mobile.controller.js";
import { MobileService } from "./mobile.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [MobileController, MobilePushWorkerController],
  providers: [MobileService],
  exports: [MobileService]
})
export class MobileModule {}
