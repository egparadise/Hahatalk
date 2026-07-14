import { Global, Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { PostgresThrottlerStorage } from "./postgres-throttler-storage.js";

@Global()
@Module({
  exports: [PostgresThrottlerStorage],
  imports: [DatabaseModule],
  providers: [PostgresThrottlerStorage]
})
export class SecurityModule {}
