import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { DatabaseService } from "../database/database.service.js";

interface BucketRow {
  blocked_until: Date | null;
  hit_count: number;
  window_expires_at: Date;
}

@Injectable()
export class PostgresThrottlerStorage implements ThrottlerStorage {
  private cleanupCounter = 0;

  constructor(private readonly database: DatabaseService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    const ttlMs = this.positiveInteger(ttl, 60_000);
    const blockMs = this.positiveInteger(blockDuration, ttlMs);
    const normalizedLimit = this.positiveInteger(limit, 1);
    const keyDigest = createHash("sha256").update(`${throttlerName}:${key}`).digest();
    const lockKey = keyDigest.toString("hex");

    const record = await this.database.transaction(async (client) => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      const nowResult = await client.query<{ now: Date }>("select clock_timestamp() as now");
      const now = nowResult.rows[0]!.now;
      const existing = await client.query<BucketRow>(
        `select hit_count, window_expires_at, blocked_until
         from rate_limit_buckets
         where key_hash = $1
         for update`,
        [keyDigest]
      );

      let hitCount = 1;
      let windowExpiresAt = new Date(now.getTime() + ttlMs);
      let blockedUntil: Date | null = null;
      const row = existing.rows[0];

      if (row?.blocked_until && row.blocked_until.getTime() > now.getTime()) {
        hitCount = row.hit_count;
        windowExpiresAt = row.window_expires_at;
        blockedUntil = row.blocked_until;
      } else if (row && row.window_expires_at.getTime() > now.getTime()) {
        hitCount = row.hit_count + 1;
        windowExpiresAt = row.window_expires_at;
        blockedUntil = hitCount > normalizedLimit ? new Date(now.getTime() + blockMs) : null;
      }

      await client.query(
        `insert into rate_limit_buckets (
           key_hash, throttler_name, hit_count, window_expires_at, blocked_until, updated_at
         ) values ($1, $2, $3, $4, $5, $6)
         on conflict (key_hash) do update
         set throttler_name = excluded.throttler_name,
             hit_count = excluded.hit_count,
             window_expires_at = excluded.window_expires_at,
             blocked_until = excluded.blocked_until,
             updated_at = excluded.updated_at`,
        [keyDigest, this.safeName(throttlerName), hitCount, windowExpiresAt, blockedUntil, now]
      );

      return {
        isBlocked: Boolean(blockedUntil && blockedUntil.getTime() > now.getTime()),
        timeToBlockExpire: blockedUntil
          ? Math.max(0, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1_000))
          : 0,
        timeToExpire: Math.max(0, Math.ceil((windowExpiresAt.getTime() - now.getTime()) / 1_000)),
        totalHits: hitCount
      };
    });

    this.cleanupCounter += 1;
    if (this.cleanupCounter % 256 === 0) {
      await this.database.query(
        `delete from rate_limit_buckets
         where greatest(window_expires_at, coalesce(blocked_until, window_expires_at)) < now() - interval '1 hour'`
      ).catch(() => undefined);
    }

    return record;
  }

  async assertAllowed(
    actorId: string,
    action: string,
    targetId: string | undefined,
    limit: number,
    ttlMs: number
  ) {
    const tracker = createHash("sha256")
      .update(`${actorId}:${action}:${targetId ?? "none"}`)
      .digest("hex");
    const result = await this.increment(tracker, ttlMs, limit, ttlMs, this.safeName(action));
    if (result.isBlocked) {
      throw new Error(`Rate limit exceeded. Retry in ${result.timeToBlockExpire || result.timeToExpire} seconds.`);
    }
  }

  private positiveInteger(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }

  private safeName(value: string) {
    const normalized = value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 64);
    return normalized || "default";
  }
}

export function createThrottleTracker(request: Record<string, any>) {
  const actor = typeof request.auth?.internalUserId === "string" ? request.auth.internalUserId : "anonymous";
  const source = String(request.ip || request.socket?.remoteAddress || "unknown");
  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const params = Object.entries(request.params ?? {})
    .filter(([, value]) => typeof value === "string")
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify({ actor, email, params, source }))
    .digest("hex");
}
