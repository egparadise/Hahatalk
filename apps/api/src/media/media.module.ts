import { Module } from "@nestjs/common";
import { ChatModule } from "../modules/chat.module.js";
import { LocalObjectStore } from "./local-object-store.js";
import { MediaController } from "./media.controller.js";
import { MediaInspector } from "./media-inspector.js";
import { MediaService } from "./media.service.js";
import { objectStoreToken } from "./object-store.js";

@Module({
  imports: [ChatModule],
  controllers: [MediaController],
  providers: [
    LocalObjectStore,
    { provide: objectStoreToken, useExisting: LocalObjectStore },
    MediaInspector,
    MediaService
  ]
})
export class MediaModule {}
