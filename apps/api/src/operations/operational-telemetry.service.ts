import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable, tap } from "rxjs";

const durationBuckets = [0.01, 0.05, 0.1, 0.3, 1, 3, 10] as const;

interface RequestMetric {
  buckets: number[];
  count: number;
  durationSeconds: number;
}

@Injectable()
export class OperationalTelemetryService {
  private readonly operations = new Map<string, number>();
  private readonly requests = new Map<string, RequestMetric>();

  recordRequest(controller: string, handler: string, method: string, statusCode: number, durationSeconds: number) {
    const labels = [
      this.label(controller),
      this.label(handler),
      this.label(method.toLowerCase()),
      `${Math.floor(statusCode / 100)}xx`
    ];
    const key = labels.join("|");
    const metric = this.requests.get(key) ?? {
      buckets: durationBuckets.map(() => 0),
      count: 0,
      durationSeconds: 0
    };
    metric.count += 1;
    metric.durationSeconds += Math.max(0, durationSeconds);
    durationBuckets.forEach((upperBound, index) => {
      if (durationSeconds <= upperBound) metric.buckets[index] = (metric.buckets[index] ?? 0) + 1;
    });
    this.requests.set(key, metric);
  }

  incrementOperation(operation: string, outcome: string) {
    const key = `${this.label(operation)}|${this.label(outcome)}`;
    this.operations.set(key, (this.operations.get(key) ?? 0) + 1);
  }

  renderPrometheus() {
    const lines = [
      "# HELP hahatalk_http_requests_total Completed HTTP requests by code-defined route.",
      "# TYPE hahatalk_http_requests_total counter"
    ];
    for (const [key, metric] of [...this.requests.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const [controller, handler, method, statusClass] = key.split("|");
      const labels = `controller="${controller}",handler="${handler}",method="${method}",status_class="${statusClass}"`;
      lines.push(`hahatalk_http_requests_total{${labels}} ${metric.count}`);
    }
    lines.push(
      "# HELP hahatalk_http_request_duration_seconds HTTP request duration by code-defined route.",
      "# TYPE hahatalk_http_request_duration_seconds histogram"
    );
    for (const [key, metric] of [...this.requests.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const [controller, handler, method, statusClass] = key.split("|");
      const baseLabels = `controller="${controller}",handler="${handler}",method="${method}",status_class="${statusClass}"`;
      durationBuckets.forEach((upperBound, index) => {
        lines.push(`hahatalk_http_request_duration_seconds_bucket{${baseLabels},le="${upperBound}"} ${metric.buckets[index]}`);
      });
      lines.push(`hahatalk_http_request_duration_seconds_bucket{${baseLabels},le="+Inf"} ${metric.count}`);
      lines.push(`hahatalk_http_request_duration_seconds_sum{${baseLabels}} ${metric.durationSeconds.toFixed(6)}`);
      lines.push(`hahatalk_http_request_duration_seconds_count{${baseLabels}} ${metric.count}`);
    }
    lines.push(
      "# HELP hahatalk_operations_total Security and lifecycle operation outcomes.",
      "# TYPE hahatalk_operations_total counter"
    );
    for (const [key, count] of [...this.operations.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const [operation, outcome] = key.split("|");
      lines.push(`hahatalk_operations_total{operation="${operation}",outcome="${outcome}"} ${count}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private label(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 80) || "unknown";
  }
}

@Injectable()
export class RequestTelemetryInterceptor implements NestInterceptor {
  constructor(private readonly telemetry: OperationalTelemetryService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const controller = context.getClass().name;
    const handler = context.getHandler().name;
    const startedAt = performance.now();
    return next.handle().pipe(tap({
      error: (error: unknown) => {
        const status = typeof (error as { getStatus?: () => number })?.getStatus === "function"
          ? (error as { getStatus: () => number }).getStatus()
          : 500;
        this.telemetry.recordRequest(controller, handler, request.method, status, (performance.now() - startedAt) / 1_000);
      },
      next: () => {
        this.telemetry.recordRequest(
          controller,
          handler,
          request.method,
          response.statusCode,
          (performance.now() - startedAt) / 1_000
        );
      }
    }));
  }
}
