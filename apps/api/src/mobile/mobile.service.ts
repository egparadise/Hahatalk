import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import type {
  MobileCapabilitiesView,
  MobileDeviceView,
  MobilePlatform,
  MobilePushJobView,
  RegisterMobileDeviceInput
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";

type DeviceRow = {
  app_version: string;
  created_at: Date;
  id: string;
  last_seen_at: Date;
  locale: string;
  mobile_session_id: string | null;
  os_version: string;
  platform: "android" | "ios";
  push_provider: "expo" | "fcm" | "apns";
  revoked_at: Date | null;
  status: "active" | "revoked";
  timezone: string;
};

type PushJobRow = {
  attempt_count: number;
  body: string;
  device_id: string;
  encryption_key_id: string;
  event_type: MobilePushJobView["eventType"];
  expires_at: Date;
  id: string;
  organization_id: string;
  payload_json: Record<string, string>;
  platform: MobilePlatform;
  push_provider: MobilePushJobView["pushProvider"];
  push_token_auth_tag: Buffer;
  push_token_ciphertext: Buffer;
  push_token_nonce: Buffer;
  recipient_id: string;
  route: string;
  title: string;
};

type PushKey = { id: string; key: Buffer };

const maxClaim = 50;
const leaseSeconds = 30;
const maxAttempts = 8;

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

function fixedSecretMatches(candidate: string | undefined, expected: string | undefined) {
  if (!candidate || !expected || candidate.length < 32 || expected.length < 32) return false;
  const left = digest(candidate);
  const right = digest(expected);
  return timingSafeEqual(left, right);
}

@Injectable()
export class MobileService {
  constructor(private readonly database: DatabaseService) {}

  capabilities(platform: MobilePlatform | "unknown" = "unknown"): MobileCapabilitiesView {
    const pushKey = this.pushKey(false);
    return {
      apiVersion: 1,
      calls: { developmentBuildRequired: true, provider: "livekit" },
      offlineQueue: { encryption: "aes-256-gcm", maxItems: 50 },
      platform,
      push: {
        dispatchMode: "external_worker",
        payloadPolicy: "generic_no_message_content",
        registrationAvailable: Boolean(pushKey),
        ...(!pushKey ? { reason: "Mobile push encryption is not configured on this server." } : {})
      },
      remoteControl: {
        available: false,
        reason: "The Windows attended-support agent is never bundled into the mobile companion."
      },
      screenShare: {
        available: false,
        reason: "ReplayKit and MediaProjection require signed development builds and physical-device approval."
      }
    };
  }

  async listDevices(principal: AuthPrincipal): Promise<MobileDeviceView[]> {
    const result = await this.database.query<DeviceRow>(
      `select id, mobile_session_id, platform, push_provider, app_version, os_version,
              locale, timezone, status, created_at, last_seen_at, revoked_at
       from mobile_devices
       where user_id = $1
       order by last_seen_at desc`,
      [principal.internalUserId]
    );
    return result.rows.map((row) => this.deviceView(row, principal.sessionId));
  }

  async registerDevice(principal: AuthPrincipal, input: RegisterMobileDeviceInput): Promise<MobileDeviceView> {
    this.assertMobilePrincipal(principal, input.installationId, input.platform);
    const pushKey = this.pushKey(true)!;
    const token = input.pushToken.trim();
    if (token.length < 20 || token.length > 4096 || /\s/.test(token)) {
      throw new BadRequestException("Push token is invalid.");
    }
    if (input.pushProvider === "expo" && !/^(Expo(nent)?PushToken)\[[A-Za-z0-9_-]+\]$/.test(token)) {
      throw new BadRequestException("Expo push token is invalid.");
    }
    const encrypted = this.encryptToken(
      token,
      pushKey,
      this.tokenAad(principal.state.user.organizationId, principal.internalUserId, input.platform, input.pushProvider)
    );
    const installationDigest = digest(input.installationId.trim().toLowerCase());
    const tokenDigest = digest(token);
    const row = await this.database.transaction(async (client) => {
      const duplicateTokens = await client.query<{ id: string }>(
        `select id from mobile_devices
         where push_token_digest = $1 and status = 'active'
           and not (user_id = $2 and installation_id_hash = $3)
         for update`,
        [tokenDigest, principal.internalUserId, installationDigest]
      );
      await this.revokeDevicesLocked(client, duplicateTokens.rows.map((device) => device.id), "push_token_reassigned");

      const existing = await client.query<{ id: string }>(
        `select id from mobile_devices
         where user_id = $1 and installation_id_hash = $2 and status = 'active'
         for update`,
        [principal.internalUserId, installationDigest]
      );
      const values = [
        principal.state.user.organizationId,
        principal.internalUserId,
        principal.sessionId,
        input.platform,
        installationDigest,
        input.pushProvider,
        tokenDigest,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        pushKey.id,
        input.appVersion,
        input.osVersion,
        input.locale,
        input.timezone,
        JSON.stringify({
          calls: Boolean(input.capabilities.calls),
          notifications: Boolean(input.capabilities.notifications)
        })
      ];
      const result = existing.rows[0]
        ? await client.query<DeviceRow>(
            `update mobile_devices
             set organization_id = $1, mobile_session_id = $3, platform = $4,
                 push_provider = $6, push_token_digest = $7, push_token_ciphertext = $8,
                 push_token_nonce = $9, push_token_auth_tag = $10, encryption_key_id = $11,
                 app_version = $12, os_version = $13, locale = $14, timezone = $15,
                 capabilities_json = $16::jsonb, last_seen_at = now(), updated_at = now()
             where id = $17
             returning id, mobile_session_id, platform, push_provider, app_version, os_version,
                       locale, timezone, status, created_at, last_seen_at, revoked_at`,
            [...values, existing.rows[0].id]
          )
        : await client.query<DeviceRow>(
            `insert into mobile_devices (
               organization_id, user_id, mobile_session_id, platform, installation_id_hash,
               push_provider, push_token_digest, push_token_ciphertext, push_token_nonce,
               push_token_auth_tag, encryption_key_id, app_version, os_version, locale,
               timezone, capabilities_json
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
             returning id, mobile_session_id, platform, push_provider, app_version, os_version,
                       locale, timezone, status, created_at, last_seen_at, revoked_at`,
            values
          );
      const device = result.rows[0]!;
      await this.audit(client, principal, "mobile.device_registered", device.id, {
        platform: input.platform,
        provider: input.pushProvider
      });
      return device;
    });
    return this.deviceView(row, principal.sessionId);
  }

  async revokeCurrentDevice(principal: AuthPrincipal) {
    if (principal.sessionKind !== "mobile") throw new ForbiddenException("A mobile session is required.");
    return this.database.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `select id from mobile_devices
         where user_id = $1 and mobile_session_id = $2 and status = 'active'
         for update`,
        [principal.internalUserId, principal.sessionId]
      );
      await this.revokeDevicesLocked(client, result.rows.map((row) => row.id), "user_device_revoke");
      for (const row of result.rows) {
        await this.audit(client, principal, "mobile.device_revoked", row.id);
      }
      return { ok: true, revokedCount: result.rowCount ?? 0 };
    });
  }

  async claimPushJobs(workerToken: string | undefined, workerId: string, requestedLimit: number): Promise<MobilePushJobView[]> {
    this.assertWorker(workerToken);
    const pushKey = this.pushKey(true)!;
    const limit = Math.max(1, Math.min(maxClaim, Math.trunc(requestedLimit)));
    return this.database.transaction(async (client) => {
      await this.materializePushEvents(client);
      await client.query(
        `update mobile_push_jobs
         set status = 'expired', completed_at = now(), updated_at = now(), last_error_code = 'job_expired'
         where status in ('queued', 'claimed') and expires_at <= now()`
      );
      const stale = await client.query<{ attempt_count: number; id: string }>(
        `update mobile_push_jobs
         set status = 'queued', available_at = now(), claimed_by = null, claimed_at = null,
             lease_expires_at = null, updated_at = now(), last_error_code = 'lease_expired'
         where status = 'claimed' and lease_expires_at <= now() and expires_at > now()
         returning id, attempt_count`
      );
      for (const row of stale.rows) {
        await client.query(
          `insert into mobile_push_attempts (job_id, attempt_number, worker_id, outcome, error_code)
           values ($1, $2, $3, 'lease_expired', 'lease_expired')
           on conflict do nothing`,
          [row.id, row.attempt_count, workerId]
        );
      }
      const jobs = await client.query<PushJobRow>(
        `select j.id, j.organization_id, j.recipient_id, j.device_id, j.event_type,
                j.title, j.body, j.route, j.payload_json, j.attempt_count, j.expires_at,
                d.platform, d.push_provider, d.push_token_ciphertext, d.push_token_nonce,
                d.push_token_auth_tag, d.encryption_key_id
         from mobile_push_jobs j
         join mobile_devices d on d.id = j.device_id and d.status = 'active'
         join mobile_sessions s on s.id = d.mobile_session_id and s.revoked_at is null
           and s.idle_expires_at > now() and s.absolute_expires_at > now()
         where j.status = 'queued' and j.available_at <= now() and j.expires_at > now()
           and j.attempt_count < $2
         order by j.created_at
         limit $1
         for update of j skip locked`,
        [limit, maxAttempts]
      );
      const claimed: MobilePushJobView[] = [];
      for (const job of jobs.rows) {
        const attempt = job.attempt_count + 1;
        let pushToken: string;
        try {
          if (job.encryption_key_id !== pushKey.id) throw new Error("Push token key id is unavailable.");
          pushToken = this.decryptToken(
            job,
            pushKey,
            this.tokenAad(job.organization_id, job.recipient_id, job.platform, job.push_provider)
          );
        } catch {
          await client.query(
            `update mobile_push_jobs
             set status = 'failed', attempt_count = $2, completed_at = now(), updated_at = now(),
                 last_error_code = 'token_decrypt_failed'
             where id = $1`,
            [job.id, attempt]
          );
          await client.query(
            `insert into mobile_push_attempts (job_id, attempt_number, worker_id, outcome, error_code)
             values ($1, $2, $3, 'failed', 'token_decrypt_failed')`,
            [job.id, attempt, workerId]
          );
          continue;
        }
        await client.query(
          `update mobile_push_jobs
           set status = 'claimed', attempt_count = $2, claimed_by = $3, claimed_at = now(),
               lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
           where id = $1`,
          [job.id, attempt, workerId, leaseSeconds]
        );
        await client.query(
          `insert into mobile_push_attempts (job_id, attempt_number, worker_id, outcome)
           values ($1, $2, $3, 'claimed')`,
          [job.id, attempt, workerId]
        );
        claimed.push({
          attempt,
          body: job.body,
          eventType: job.event_type,
          expiresAt: job.expires_at.toISOString(),
          id: job.id,
          payload: job.payload_json,
          pushProvider: job.push_provider,
          pushToken,
          route: job.route,
          title: job.title
        });
      }
      return claimed;
    });
  }

  async completePushJob(
    workerToken: string | undefined,
    workerId: string,
    jobId: string,
    outcome: "delivered" | "failed",
    input: { errorCode?: string; providerMessageId?: string; retryable?: boolean }
  ) {
    this.assertWorker(workerToken);
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        attempt_count: number;
        expires_at: Date;
        status: string;
      }>(
        `select status, attempt_count, expires_at from mobile_push_jobs
         where id = $1 and claimed_by = $2
         for update`,
        [jobId, workerId]
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException("Claimed mobile push job was not found.");
      if (row.status !== "claimed") throw new ConflictException("Mobile push job is not claimed.");
      const shouldRetry = outcome === "failed"
        && Boolean(input.retryable)
        && row.attempt_count < maxAttempts
        && row.expires_at.getTime() > Date.now();
      const status = shouldRetry ? "queued" : outcome;
      await client.query(
        `update mobile_push_jobs
         set status = $3, available_at = case when $3 = 'queued'
               then now() + make_interval(secs => least(300, (2 ^ least(attempt_count, 8))::int))
               else available_at end,
             claimed_by = case when $3 = 'queued' then null else claimed_by end,
             claimed_at = case when $3 = 'queued' then null else claimed_at end,
             lease_expires_at = null,
             completed_at = case when $3 = 'queued' then null else now() end,
             provider_message_id = $4, last_error_code = $5, updated_at = now()
         where id = $1 and claimed_by = $2`,
        [jobId, workerId, status, input.providerMessageId ?? null, input.errorCode ?? null]
      );
      await client.query(
        `insert into mobile_push_attempts (job_id, attempt_number, worker_id, outcome, error_code)
         values ($1, $2, $3, $4, $5)`,
        [jobId, row.attempt_count, workerId, outcome, input.errorCode ?? null]
      );
      return { ok: true, status };
    });
  }

  private async materializePushEvents(client: PoolClient) {
    await client.query(
      `insert into mobile_push_jobs (
         organization_id, recipient_id, device_id, event_key, event_type,
         title, body, route, payload_json, expires_at
       )
       select device.organization_id, participant.user_id, device.id,
              'call:' || call_session.id::text || ':invite', 'call.invite',
              'HahaTalk 통화', '새 통화 요청이 있습니다.', '/call/' || call_session.id::text,
              jsonb_build_object('route', '/call/' || call_session.id::text, 'eventType', 'call.invite'),
              least(call_session.expires_at, now() + interval '2 minutes')
       from call_sessions call_session
       join call_participants participant on participant.call_session_id = call_session.id
       join mobile_devices device on device.user_id = participant.user_id and device.status = 'active'
       join mobile_sessions session on session.id = device.mobile_session_id
         and session.revoked_at is null and session.idle_expires_at > now() and session.absolute_expires_at > now()
       where call_session.session_kind = 'ad_hoc' and call_session.status = 'ringing'
         and call_session.expires_at > now() + interval '1 second'
         and participant.status = 'invited' and participant.user_id <> call_session.created_by
       on conflict (device_id, event_key) do nothing`
    );
    await client.query(
      `insert into mobile_push_jobs (
         organization_id, recipient_id, device_id, event_key, event_type,
         title, body, route, payload_json, expires_at
       )
       select device.organization_id, participant.user_id, device.id,
              'meeting:' || meeting.id::text || ':lobby', 'meeting.lobby',
              'HahaTalk 회의', '예약 회의 입장이 열렸습니다.', '/meeting/' || meeting.id::text,
              jsonb_build_object('route', '/meeting/' || meeting.id::text, 'eventType', 'meeting.lobby'),
              least(meeting.expires_at, now() + interval '4 hours')
       from call_sessions meeting
       join call_participants participant on participant.call_session_id = meeting.id
       join mobile_devices device on device.user_id = participant.user_id and device.status = 'active'
       join mobile_sessions session on session.id = device.mobile_session_id
         and session.revoked_at is null and session.idle_expires_at > now() and session.absolute_expires_at > now()
       where meeting.session_kind = 'scheduled_meeting' and meeting.status = 'lobby_open'
         and meeting.expires_at > now() + interval '1 second'
         and participant.status in ('invited', 'waiting', 'admitted')
         and participant.user_id <> meeting.created_by
       on conflict (device_id, event_key) do nothing`
    );
    await client.query(
      `insert into mobile_push_jobs (
         organization_id, recipient_id, device_id, event_key, event_type,
         title, body, route, payload_json, expires_at
       )
       select device.organization_id, subscription.user_id, device.id,
              'broadcast:' || broadcast.id::text || ':started', 'broadcast.started',
              'HahaTalk LIVE', '새 라이브 방송이 시작되었습니다.', '/broadcast/' || broadcast.id::text,
              jsonb_build_object('route', '/broadcast/' || broadcast.id::text, 'eventType', 'broadcast.started'),
              now() + interval '4 hours'
       from broadcast_sessions broadcast
       join channel_subscriptions subscription on subscription.channel_id = broadcast.channel_id
         and subscription.status = 'active' and subscription.notification_level in ('all', 'live_only')
       join mobile_devices device on device.user_id = subscription.user_id and device.status = 'active'
       join mobile_sessions session on session.id = device.mobile_session_id
         and session.revoked_at is null and session.idle_expires_at > now() and session.absolute_expires_at > now()
       where broadcast.status = 'live' and subscription.user_id <> broadcast.created_by
       on conflict (device_id, event_key) do nothing`
    );
  }

  private assertMobilePrincipal(principal: AuthPrincipal, installationId: string, platform: MobilePlatform) {
    if (principal.sessionKind !== "mobile" || !principal.mobileInstallationHash) {
      throw new ForbiddenException("A mobile session is required.");
    }
    const requestedHash = digest(installationId.trim().toLowerCase()).toString("hex");
    if (requestedHash !== principal.mobileInstallationHash) {
      throw new ForbiddenException("Mobile installation does not match the authenticated session.");
    }
  }

  private assertWorker(token: string | undefined) {
    if (!fixedSecretMatches(token, process.env.MOBILE_PUSH_WORKER_TOKEN?.trim())) {
      throw new UnauthorizedException("Mobile push worker authentication is required.");
    }
  }

  private pushKey(required: boolean): PushKey | undefined {
    const encoded = process.env.MOBILE_PUSH_TOKEN_KEY?.trim();
    if (!encoded) {
      if (required) throw new ServiceUnavailableException("Mobile push token encryption is not configured.");
      return undefined;
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      if (required) throw new ServiceUnavailableException("Mobile push token encryption key is invalid.");
      return undefined;
    }
    return {
      id: process.env.MOBILE_PUSH_TOKEN_KEY_ID?.trim() || createHash("sha256").update(key).digest("hex").slice(0, 16),
      key
    };
  }

  private tokenAad(organizationId: string, userId: string, platform: string, provider: string) {
    return Buffer.from(`${organizationId}:${userId}:${platform}:${provider}`, "utf8");
  }

  private encryptToken(token: string, key: PushKey, aad: Buffer) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key.key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return { authTag: cipher.getAuthTag(), ciphertext, nonce };
  }

  private decryptToken(row: PushJobRow, key: PushKey, aad: Buffer) {
    const decipher = createDecipheriv("aes-256-gcm", key.key, row.push_token_nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(row.push_token_auth_tag);
    return Buffer.concat([decipher.update(row.push_token_ciphertext), decipher.final()]).toString("utf8");
  }

  private deviceView(row: DeviceRow, currentSessionId: string): MobileDeviceView {
    return {
      appVersion: row.app_version,
      createdAt: row.created_at.toISOString(),
      current: row.mobile_session_id === currentSessionId,
      id: row.id,
      lastSeenAt: row.last_seen_at.toISOString(),
      locale: row.locale,
      osVersion: row.os_version,
      platform: row.platform,
      pushProvider: row.push_provider,
      ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
      status: row.status,
      timezone: row.timezone
    };
  }

  private async revokeDevicesLocked(client: PoolClient, ids: string[], reason: string) {
    if (!ids.length) return;
    await client.query(
      `update mobile_devices
       set status = 'revoked', revoked_at = now(), revoke_reason = $2, updated_at = now()
       where id = any($1::uuid[]) and status = 'active'`,
      [ids, reason]
    );
    await client.query(
      `update mobile_push_jobs
       set status = 'cancelled', completed_at = now(), updated_at = now(), last_error_code = 'device_revoked'
       where device_id = any($1::uuid[]) and status in ('queued', 'claimed')`,
      [ids]
    );
  }

  private audit(
    client: PoolClient,
    principal: AuthPrincipal,
    action: string,
    targetId: string,
    metadata: Record<string, string> = {}
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, 'mobile_device', $4, $5::jsonb)`,
      [
        principal.state.user.organizationId,
        principal.internalUserId,
        action,
        targetId,
        JSON.stringify(metadata)
      ]
    );
  }
}
