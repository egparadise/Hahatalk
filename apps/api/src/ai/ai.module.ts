import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module.js";
import { ChatModule } from "../modules/chat.module.js";
import { AiController, AiWorkerController } from "./ai.controller.js";
import { AiDispatchService } from "./ai-dispatch.service.js";
import { AiService } from "./ai.service.js";

@Module({
  imports: [ChatModule, MediaModule],
  controllers: [AiController, AiWorkerController],
  providers: [AiDispatchService, AiService],
  exports: [AiService]
})
export class AiModule {}
