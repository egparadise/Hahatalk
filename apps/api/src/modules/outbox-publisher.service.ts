import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConversationService } from "./conversation.service.js";
import { RealtimeDeliveryService } from "./realtime-delivery.service.js";

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly inFlight = new Set<string>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly conversations: ConversationService,
    private readonly realtime: RealtimeDeliveryService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.publishBatch(), 250);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async publishBatch() {
    if (this.running || !this.realtime.ready) {
      return;
    }
    this.running = true;
    try {
      const events = await this.conversations.nextOutboxEvents();
      for (const event of events) {
        if (this.inFlight.has(event.id)) {
          continue;
        }
        this.inFlight.add(event.id);
        try {
          const envelope = await this.conversations.realtimeEnvelope(event);
          if (envelope) {
            this.realtime.emitToUser(envelope.publicUserId, envelope.event, envelope.payload);
          }
          await this.conversations.markOutboxPublished(event.id);
        } catch (error) {
          await this.conversations.markOutboxFailed(event.id, error).catch(() => undefined);
          this.logger.warn(`Outbox event ${event.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          this.inFlight.delete(event.id);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
