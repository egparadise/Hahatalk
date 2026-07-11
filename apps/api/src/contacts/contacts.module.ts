import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ContactsController } from "./contacts.controller.js";
import { ContactsService } from "./contacts.service.js";

@Module({
  controllers: [ContactsController],
  imports: [AuthModule],
  providers: [ContactsService]
})
export class ContactsModule {}
