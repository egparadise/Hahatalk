import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { ChatModule } from "./modules/chat.module.js";

@Module({
  imports: [DatabaseModule, AuthModule, ChatModule]
})
export class AppModule {}
