import { Logger, OnModuleDestroy, OnModuleInit, Injectable } from "@nestjs/common";
import { createClient, type RedisClientType } from "redis";
import { DatabaseService } from "../database/database.service.js";

const streamName = "hahatalk:ai:jobs:v1";

@Injectable()
export class AiDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiDispatchService.name);
  private client?: RedisClientType;
  private connected = false;
  readonly redisUrl = process.env.AI_REDIS_URL?.trim();

  constructor(private readonly database: DatabaseService) {}

  get mode(): "configured" | "database_poll" {
    return this.redisUrl ? "configured" : "database_poll";
  }

  async onModuleInit() {
    if (!this.redisUrl) {
      this.logger.log("AI jobs use durable database polling; Redis dispatch is not configured.");
      return;
    }
    const client = createClient({
      url: this.redisUrl,
      socket: {
        connectTimeout: 1_500,
        reconnectStrategy: false
      }
    });
    client.on("error", (error) => {
      this.connected = false;
      this.logger.warn(`AI Redis dispatch unavailable: ${error instanceof Error ? error.message : "connection error"}`);
    });
    try {
      await client.connect();
      this.client = client as RedisClientType;
      this.connected = true;
      this.logger.log("AI Redis Stream dispatch is ready.");
    } catch {
      await client.disconnect().catch(() => undefined);
      this.logger.warn("AI Redis dispatch could not start; durable database polling remains available.");
    }
  }

  async onModuleDestroy() {
    if (this.client?.isOpen) {
      await this.client.quit().catch(() => this.client?.disconnect());
    }
  }

  async notify(jobId: string, jobType: string) {
    const dispatch = await this.database.query<{ id: string }>(
      `insert into ai_job_dispatches (job_id, transport, status)
       values ($1, $2, 'pending') returning id::text`,
      [jobId, this.redisUrl ? "redis_stream" : "database_poll"]
    );
    const dispatchId = dispatch.rows[0]!.id;
    if (!this.redisUrl) {
      await this.markPublished(dispatchId);
      return;
    }
    if (!this.connected || !this.client) {
      await this.markFailed(dispatchId, "redis_unavailable");
      return;
    }
    try {
      // Only opaque routing fields may cross the Redis boundary.
      await this.client.xAdd(streamName, "*", { jobId, jobType, schemaVersion: "1" }, { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 10_000 } });
      await this.markPublished(dispatchId);
    } catch {
      this.connected = false;
      await this.markFailed(dispatchId, "redis_publish_failed");
    }
  }

  private markPublished(id: string) {
    return this.database.query(
      `update ai_job_dispatches
       set status = 'published', attempt_count = attempt_count + 1, published_at = now(), last_error_code = null
       where id = $1`,
      [id]
    );
  }

  private markFailed(id: string, code: string) {
    return this.database.query(
      `update ai_job_dispatches
       set status = 'failed', attempt_count = attempt_count + 1, last_error_code = $2
       where id = $1`,
      [id, code]
    );
  }
}
