import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { MediaModule } from "../media/media.module.js";
import { AuditExportService } from "./audit-export.service.js";
import { LifecycleService } from "./lifecycle.service.js";
import { OperationsContextService } from "./operations-context.service.js";
import { OperationsController } from "./operations.controller.js";
import { OperationalTelemetryService, RequestTelemetryInterceptor } from "./operational-telemetry.service.js";
import { ReleaseService } from "./release.service.js";

@Module({
  controllers: [OperationsController],
  imports: [MediaModule],
  providers: [
    AuditExportService,
    LifecycleService,
    OperationsContextService,
    OperationalTelemetryService,
    ReleaseService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestTelemetryInterceptor
    }
  ]
})
export class OperationsModule {}
