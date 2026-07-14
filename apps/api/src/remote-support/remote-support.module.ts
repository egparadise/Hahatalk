import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { RemoteSupportAgentController, RemoteSupportController } from "./remote-support.controller.js";
import { RemoteSupportService } from "./remote-support.service.js";

@Module({
  controllers: [RemoteSupportController, RemoteSupportAgentController],
  imports: [DatabaseModule],
  providers: [RemoteSupportService]
})
export class RemoteSupportModule {}
