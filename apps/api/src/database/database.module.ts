import { Global, Module } from "@nestjs/common";
import { DatabaseService } from "./database.service.js";

@Global()
@Module({
  exports: [DatabaseService],
  providers: [DatabaseService]
})
export class DatabaseModule {}
