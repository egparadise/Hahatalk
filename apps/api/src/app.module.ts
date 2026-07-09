import { Module } from "@nestjs/common";
import { ChatModule } from "./modules/chat.module.js";

@Module({
  imports: [ChatModule]
})
export class AppModule {}

