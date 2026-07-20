import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import type {
  AiCapabilityView,
  AiJob,
  AiJobType,
  AudienceType,
  AvatarProfileView,
  MemberRole,
  SendConversationMessageInput,
  VoiceProfileConsentView,
  VoiceProfileView,
  VoiceTranscriptView
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";
import { MediaInspector } from "../media/media-inspector.js";
import { type ObjectStore, objectStoreToken } from "../media/object-store.js";
import { ConversationService } from "../modules/conversation.service.js";
import { AiDispatchService } from "./ai-dispatch.service.js";

const protocolVersion = 1 as const;
const workerJobTypes: AiJobType[] = [
  "stt",
  "tts",
  "summary",
  "avatar_generation",
  "voice_profile_enrollment",
  "voice_profile_delete"
];

type ModelCapability = "stt" | "summary" | "tts_standard" | "tts_voice_profile" | "avatar";

type JobRow = {
  attempt_count: number;
  capability: string;
  completed_at: Date | null;
  created_at: Date;
  deployment_mode: "local" | "private_server" | "managed_api";
  error_code: string | null;
  error_message: string | null;
  id: string;
  input_asset_id: string | null;
  input_json: Record<string, unknown>;
  job_type: AiJobType;
  max_attempts: number;
  model_name: string;
  organization_id: string;
  progress: number;
  provider: string;
  requested_by_public_id: string;
  result_json: Record<string, unknown> | null;
  space_id: string | null;
  started_at: Date | null;
  status: AiJob["status"];
  transcript_ai_job_id: string | null;
  transcript_approved_message_id: string | null;
  transcript_created_at: Date | null;
  transcript_draft_text: string | null;
  transcript_edited_text: string | null;
  transcript_id: string | null;
  transcript_language: string | null;
  transcript_review_status: VoiceTranscriptView["reviewStatus"] | null;
  transcript_source_asset_id: string | null;
  transcript_updated_at: Date | null;
};

type ClaimedJobRow = {
  attempt_count: number;
  capability: string;
  deployment_mode: string;
  fencing_token: string;
  id: string;
  input_asset_id: string | null;
  input_json: Record<string, unknown>;
  job_type: AiJobType;
  lease_expires_at: Date;
  model_name: string;
  organization_id: string;
  provider: string;
  requested_by: string;
  space_id: string | null;
};

type CreateJobSpec = {
  capability: ModelCapability;
  inputAssetId?: string;
  inputJson: Record<string, unknown>;
  jobType: AiJobType;
  idempotencyKey: string;
  maxAttempts?: number;
  requestShape: Record<string, unknown>;
  spaceId?: string;
  prepare?: (client: PoolClient, jobId: string) => Promise<void>;
};

type WorkerLease = {
  fencing_token: string;
  id: string;
  input_asset_id: string | null;
  input_json: Record<string, unknown>;
  job_type: AiJobType;
  model_config_id: string;
  organization_id: string;
  requested_by: string;
};

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeString(value: unknown, field: string, maxLength = 10_000) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new BadRequestException(`${field} is invalid.`);
  }
  return value.trim();
}

function safeStringArray(value: unknown, field: string, maxItems = 30) {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length > 1_000)) {
    throw new BadRequestException(`${field} is invalid.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function sanitizeFileName(value: string) {
  const normalized = value.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return normalized.slice(0, 180) || "ai-output.bin";
}

@Injectable()
export class AiService {
  constructor(
    private readonly database: DatabaseService,
    private readonly dispatch: AiDispatchService,
    private readonly conversations: ConversationService,
    @Inject(objectStoreToken) private readonly objects: ObjectStore,
    private readonly inspector: MediaInspector
  ) {}

  async capabilities(): Promise<AiCapabilityView> {
    const [models, workers] = await Promise.all([
      this.database.query<{
        capability: string;
        deployment_mode: AiCapabilityView["models"][number]["deploymentMode"];
        enabled: boolean;
        model_family: string;
        model_name: string;
        provider: string;
      }>(
        `select capability, deployment_mode, enabled, model_family, model_name, provider
         from ai_model_configs order by capability, model_name`
      ),
      this.database.query<{ capabilities: string[]; last_seen_at: Date; worker_id: string }>(
        `select worker_id, capabilities, last_seen_at from ai_workers
         where last_seen_at > now() - interval '90 seconds'
         order by last_seen_at desc`
      )
    ]);
    return {
      chatIndependent: true,
      durableQueue: true,
      redisDispatch: this.dispatch.mode,
      protocolVersion,
      activeWorkers: workers.rows.map((row) => ({
        workerId: row.worker_id,
        capabilities: row.capabilities,
        lastSeenAt: row.last_seen_at.toISOString()
      })),
      models: models.rows.map((row) => ({
        capability: row.capability,
        deploymentMode: row.deployment_mode,
        enabled: row.enabled,
        modelFamily: row.model_family,
        name: row.model_name,
        provider: row.provider
      }))
    };
  }

  async listJobs(principal: AuthPrincipal, spaceId?: string) {
    const result = await this.database.query<JobRow>(
      `${this.jobSelect()}
       where j.requested_by = $1 and j.organization_id = $2
         and ($3::uuid is null or j.space_id = $3)
       order by j.created_at desc, j.id desc limit 100`,
      [principal.internalUserId, principal.state.user.organizationId, spaceId ?? null]
    );
    return result.rows.map((row) => this.jobView(row));
  }

  async getJob(principal: AuthPrincipal, jobId: string) {
    return this.ownedJob(principal, jobId);
  }

  createStt(principal: AuthPrincipal, input: { assetId: string; idempotencyKey: string; language?: string }) {
    const language = input.language?.trim() || "auto";
    if (!/^(auto|[a-z]{2,3}(?:-[A-Z]{2})?)$/.test(language)) {
      throw new BadRequestException("STT language is invalid.");
    }
    return this.createJob(principal, {
      capability: "stt",
      inputAssetId: input.assetId,
      inputJson: { language, source: "uploaded_media" },
      jobType: "stt",
      idempotencyKey: input.idempotencyKey,
      requestShape: { assetId: input.assetId, language },
      prepare: async (client) => {
        await this.assertAssetAccess(client, principal, input.assetId, "audio", false);
      }
    });
  }

  createSummary(principal: AuthPrincipal, input: { idempotencyKey: string; spaceId: string }) {
    return this.createJob(principal, {
      capability: "summary",
      inputJson: { format: "summary_decisions_tasks", snapshotVersion: 1 },
      jobType: "summary",
      idempotencyKey: input.idempotencyKey,
      requestShape: { spaceId: input.spaceId },
      spaceId: input.spaceId,
      prepare: async (client, jobId) => {
        await this.assertSpaceMembership(client, principal, input.spaceId);
        const messages = await client.query<{ id: string }>(
          `select m.id
           from messages m
           join message_deliveries d on d.message_id = m.id
           where m.space_id = $1 and d.recipient_id = $2
             and d.revoked_at is null and m.deleted_at is null and m.message_type <> 'system'
           order by m.created_at desc, m.id desc limit 200`,
          [input.spaceId, principal.internalUserId]
        );
        if (!messages.rowCount) throw new BadRequestException("There are no visible messages to summarize.");
        const ordered = [...messages.rows].reverse();
        for (const [position, message] of ordered.entries()) {
          await client.query(
            `insert into ai_summary_inputs (job_id, message_id, position) values ($1, $2, $3)`,
            [jobId, message.id, position]
          );
        }
      }
    });
  }

  async createTts(principal: AuthPrincipal, input: {
    idempotencyKey: string;
    speed?: number;
    text: string;
    voiceId?: string;
    voiceProfileId?: string;
  }) {
    const text = safeString(input.text, "TTS text", 4_000);
    const speed = input.speed ?? 1;
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new BadRequestException("TTS speed must be between 0.5 and 2.");
    const voiceId = input.voiceProfileId ? "consented-profile" : input.voiceId?.trim() || "Sohee";
    if (!input.voiceProfileId && voiceId !== "Sohee") throw new BadRequestException("Only the standard Korean voice Sohee is enabled.");
    const textHash = stableHash(text);
    const settingsHash = stableHash({ speed, voiceId, voiceProfileId: input.voiceProfileId ?? null });
    return this.createJob(principal, {
      capability: input.voiceProfileId ? "tts_voice_profile" : "tts_standard",
      inputJson: { language: "Korean", speed, text, textHash, settingsHash, voiceId, voiceProfileId: input.voiceProfileId ?? null },
      jobType: "tts",
      idempotencyKey: input.idempotencyKey,
      requestShape: { speed, textHash, voiceId, voiceProfileId: input.voiceProfileId ?? null },
      prepare: async (client, jobId) => {
        if (input.voiceProfileId) {
          await this.assertActiveVoiceProfile(client, principal, input.voiceProfileId);
        }
        const cached = await client.query<{ media_asset_id: string }>(
          `select media_asset_id from tts_assets
           where requested_by = $1 and text_hash = $2 and settings_hash = $3
             and voice_profile_id is not distinct from $4::uuid
           limit 1`,
          [principal.internalUserId, textHash, settingsHash, input.voiceProfileId ?? null]
        );
        if (cached.rows[0]) {
          await client.query(
            `update ai_jobs set status = 'succeeded', progress = 100,
               result_json = jsonb_build_object('aiGenerated', true, 'cacheHit', true, 'mediaAssetId', $2::text),
               completed_at = now()
             where id = $1`,
            [jobId, cached.rows[0].media_asset_id]
          );
        }
      }
    });
  }

  createAvatar(principal: AuthPrincipal, input: {
    assetId: string;
    consentToStoreSource: boolean;
    idempotencyKey: string;
    style?: string;
  }) {
    if (!input.consentToStoreSource) throw new BadRequestException("Avatar source storage consent is required.");
    const style = input.style?.trim() || "work-friendly";
    if (!/^[a-z0-9-]{3,40}$/i.test(style)) throw new BadRequestException("Avatar style is invalid.");
    const avatarId = randomUUID();
    return this.createJob(principal, {
      capability: "avatar",
      inputAssetId: input.assetId,
      inputJson: { avatarId, consentToStoreSource: true, style },
      jobType: "avatar_generation",
      idempotencyKey: input.idempotencyKey,
      requestShape: { assetId: input.assetId, consentToStoreSource: true, style },
      prepare: async (client, jobId) => {
        await this.assertAssetAccess(client, principal, input.assetId, "image", true);
        await client.query(
          `insert into avatar_profiles (
             id, user_id, source_asset_id, generation_job_id, avatar_type, style,
             ai_generated, consent_to_store_source, status
           ) values ($1, $2, $3, $4, 'caricature', $5, true, true, 'pending')`,
          [avatarId, principal.internalUserId, input.assetId, jobId, style]
        );
      }
    });
  }

  async cancelJob(principal: AuthPrincipal, jobId: string) {
    const result = await this.database.transaction(async (client) => {
      const row = await this.lockOwnedJob(client, principal, jobId);
      if (["succeeded", "cancelled"].includes(row.status)) return;
      await client.query(
        `update ai_job_attempts set status = 'cancelled', finished_at = now()
         where job_id = $1 and status = 'running'`,
        [jobId]
      );
      await client.query(
        `update ai_jobs set status = 'cancelled', lease_owner = null, lease_expires_at = null,
           cancelled_at = now(), completed_at = now(), error_code = null, error_message = null
         where id = $1`,
        [jobId]
      );
      if (row.job_type === "voice_profile_enrollment") {
        await client.query("update voice_profiles set status = 'revoked', revoked_at = now() where enrollment_job_id = $1 and status = 'pending'", [jobId]);
      }
    });
    void result;
    return this.ownedJob(principal, jobId);
  }

  async retryJob(principal: AuthPrincipal, jobId: string) {
    const jobType = await this.database.transaction(async (client) => {
      const row = await this.lockOwnedJob(client, principal, jobId);
      if (row.status !== "failed") throw new ConflictException("Only a failed AI job can be retried.");
      await client.query(
        `update ai_jobs set status = 'queued', available_at = now(), completed_at = null,
           error_code = null, error_message = null, progress = 0,
           max_attempts = greatest(max_attempts, attempt_count + 1)
         where id = $1`,
        [jobId]
      );
      return row.job_type;
    });
    await this.dispatch.notify(jobId, jobType);
    return this.ownedJob(principal, jobId);
  }

  async editTranscript(principal: AuthPrincipal, transcriptId: string, text: string) {
    const normalized = safeString(text, "Transcript text");
    const result = await this.database.query(
      `update voice_transcripts transcript
       set edited_text = $3, updated_at = now()
       from ai_jobs job
       where transcript.id = $1 and transcript.ai_job_id = job.id
         and job.requested_by = $2 and job.organization_id = $4
         and transcript.review_status = 'ai_draft'
       returning transcript.id`,
      [transcriptId, principal.internalUserId, normalized, principal.state.user.organizationId]
    );
    if (!result.rowCount) throw new ConflictException("Only an AI draft transcript can be edited.");
    return this.transcript(principal, transcriptId);
  }

  async rejectTranscript(principal: AuthPrincipal, transcriptId: string) {
    const result = await this.database.query(
      `update voice_transcripts transcript
       set review_status = 'rejected', reviewed_by = $2, reviewed_at = now(), updated_at = now()
       from ai_jobs job
       where transcript.id = $1 and transcript.ai_job_id = job.id
         and job.requested_by = $2 and job.organization_id = $3
         and transcript.review_status = 'ai_draft'
       returning transcript.id`,
      [transcriptId, principal.internalUserId, principal.state.user.organizationId]
    );
    if (!result.rowCount) throw new ConflictException("Only an AI draft transcript can be rejected.");
    return this.transcript(principal, transcriptId);
  }

  async sendTranscript(principal: AuthPrincipal, transcriptId: string, input: SendConversationMessageInput) {
    const transcriptText = await this.database.transaction(async (client) => {
      const result = await client.query<{
        draft_text: string;
        edited_text: string | null;
        review_status: VoiceTranscriptView["reviewStatus"];
        send_client_message_id: string | null;
      }>(
        `select transcript.draft_text, transcript.edited_text, transcript.review_status, transcript.send_client_message_id
         from voice_transcripts transcript
         join ai_jobs job on job.id = transcript.ai_job_id
         where transcript.id = $1 and job.requested_by = $2 and job.organization_id = $3
         for update`,
        [transcriptId, principal.internalUserId, principal.state.user.organizationId]
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundException("Transcript was not found.");
      if (row.review_status === "reviewed" || row.review_status === "rejected") {
        throw new ConflictException("Transcript review is already complete.");
      }
      if (row.review_status === "sending" && row.send_client_message_id !== input.clientMessageId) {
        throw new ConflictException("Transcript is already being sent by another request.");
      }
      await client.query(
        `update voice_transcripts set review_status = 'sending', send_client_message_id = $2, updated_at = now()
         where id = $1`,
        [transcriptId, input.clientMessageId]
      );
      return row.edited_text ?? row.draft_text;
    });

    try {
      const sent = await this.conversations.sendMessage(
        principal,
        { ...input, body: transcriptText },
        { aiDraftReviewed: true, aiGenerated: true, aiSource: "stt", transcriptId }
      );
      await this.database.query(
        `update voice_transcripts
         set review_status = 'reviewed', reviewed_by = $2, reviewed_at = now(),
             approved_message_id = $3, updated_at = now()
         where id = $1 and review_status = 'sending'`,
        [transcriptId, principal.internalUserId, sent.message.id]
      );
      return { message: sent.message, transcript: await this.transcript(principal, transcriptId) };
    } catch (error) {
      await this.database.query(
        `update voice_transcripts set review_status = 'ai_draft', send_client_message_id = null, updated_at = now()
         where id = $1 and review_status = 'sending' and approved_message_id is null`,
        [transcriptId]
      );
      throw error;
    }
  }

  async createVoiceConsent(principal: AuthPrincipal, input: {
    acknowledged: boolean;
    expiresInDays?: number;
    referenceAssetId: string;
  }): Promise<VoiceProfileConsentView> {
    if (!input.acknowledged) throw new BadRequestException("All synthetic voice disclosures must be acknowledged.");
    const days = input.expiresInDays ?? 30;
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new BadRequestException("Voice consent duration must be between 1 and 90 days.");
    const id = randomUUID();
    const digest = stableHash({
      disclosureVersion: "hahatalk-synthetic-voice-v1",
      policyVersion: "hahatalk-voice-consent-v1",
      purpose: "personal_tts",
      referenceAssetId: input.referenceAssetId,
      subject: principal.state.user.id
    });
    await this.database.transaction(async (client) => {
      await this.assertAssetAccess(client, principal, input.referenceAssetId, "audio", true);
      await client.query(
        `insert into voice_profile_consents (
           id, organization_id, subject_user_id, reference_asset_id, purpose,
           policy_version, disclosure_version, consent_digest, expires_at
         ) values ($1, $2, $3, $4, 'personal_tts', 'hahatalk-voice-consent-v1',
           'hahatalk-synthetic-voice-v1', $5, now() + make_interval(days => $6))`,
        [id, principal.state.user.organizationId, principal.internalUserId, input.referenceAssetId, digest, days]
      );
      await this.audit(client, principal, "ai.voice_consent.granted", "voice_profile_consent", id, { policyVersion: "hahatalk-voice-consent-v1" });
    });
    return this.voiceConsent(principal, id);
  }

  async createVoiceProfile(principal: AuthPrincipal, input: {
    consentId: string;
    idempotencyKey: string;
  }) {
    const profileId = randomUUID();
    const consent = await this.database.query<{ reference_asset_id: string }>(
      `select reference_asset_id from voice_profile_consents
       where id = $1 and subject_user_id = $2 and organization_id = $3
         and status = 'active' and expires_at > now()`,
      [input.consentId, principal.internalUserId, principal.state.user.organizationId]
    );
    const consentRow = consent.rows[0];
    if (!consentRow) throw new ForbiddenException("An active personal voice consent is required.");
    const job = await this.createJob(principal, {
      capability: "tts_voice_profile",
      inputAssetId: consentRow.reference_asset_id,
      inputJson: { consentId: input.consentId, profileId, watermarkRequired: true },
      jobType: "voice_profile_enrollment",
      idempotencyKey: input.idempotencyKey,
      requestShape: { consentId: input.consentId },
      prepare: async (client, jobId) => {
        await this.assertAssetAccess(client, principal, consentRow.reference_asset_id, "audio", true);
        const config = await this.modelConfig(client, "tts_voice_profile");
        await client.query(
          `insert into voice_profiles (
             id, organization_id, subject_user_id, created_by, reference_asset_id,
             model_config_id, consent_id, enrollment_job_id
           ) values ($1, $2, $3, $3, $4, $5, $6, $7)`,
          [profileId, principal.state.user.organizationId, principal.internalUserId, consentRow.reference_asset_id, config.id, input.consentId, jobId]
        );
      }
    });
    return { job, profile: await this.voiceProfileByEnrollmentJob(principal, job.id) };
  }

  async listVoiceProfiles(principal: AuthPrincipal) {
    const result = await this.database.query(
      `select profile.id from voice_profiles profile
       where profile.subject_user_id = $1 and profile.organization_id = $2
       order by profile.created_at desc`,
      [principal.internalUserId, principal.state.user.organizationId]
    );
    const profiles: VoiceProfileView[] = [];
    for (const row of result.rows as Array<{ id: string }>) profiles.push(await this.voiceProfile(principal, row.id));
    return profiles;
  }

  async revokeVoiceProfile(principal: AuthPrincipal, profileId: string) {
    const result = await this.database.transaction(async (client) => {
      const profile = await client.query<{ consent_id: string; status: string }>(
        `select consent_id, status from voice_profiles
         where id = $1 and subject_user_id = $2 and organization_id = $3 for update`,
        [profileId, principal.internalUserId, principal.state.user.organizationId]
      );
      const row = profile.rows[0];
      if (!row) throw new NotFoundException("Voice profile was not found.");
      if (row.status === "deleted") return false;
      await client.query(
        `update voice_profile_consents set status = 'revoked', revoked_at = coalesce(revoked_at, now())
         where id = $1 and status <> 'revoked'`,
        [row.consent_id]
      );
      await client.query(
        `update voice_profiles set status = 'revoked', revoked_at = coalesce(revoked_at, now()) where id = $1`,
        [profileId]
      );
      await client.query(
        `update ai_job_attempts attempt set status = 'cancelled', finished_at = now()
         from ai_jobs job
         where attempt.job_id = job.id and attempt.status = 'running'
           and job.requested_by = $1 and job.job_type = 'tts'
           and job.input_json ->> 'voiceProfileId' = $2`,
        [principal.internalUserId, profileId]
      );
      await client.query(
        `update ai_jobs set status = 'cancelled', lease_owner = null, lease_expires_at = null,
           cancelled_at = now(), completed_at = now(), error_code = 'voice_consent_revoked',
           error_message = 'Voice consent was revoked.'
         where requested_by = $1 and job_type = 'tts'
           and input_json ->> 'voiceProfileId' = $2 and status in ('queued', 'running')`,
        [principal.internalUserId, profileId]
      );
      await this.audit(client, principal, "ai.voice_profile.revoked", "voice_profile", profileId, {});
      return true;
    });
    if (result) await this.queueVoiceProfileDeletion(principal, profileId);
    return this.voiceProfile(principal, profileId);
  }

  async listAvatars(principal: AuthPrincipal): Promise<AvatarProfileView[]> {
    const result = await this.database.query<{
      ai_generated: boolean;
      avatar_type: AvatarProfileView["avatarType"];
      consent_to_store_source: boolean;
      created_at: Date;
      display_asset_id: string | null;
      id: string;
      source_asset_id: string | null;
      status: AvatarProfileView["status"];
      style: string;
    }>(
      `select id, source_asset_id, display_asset_id, avatar_type, style, ai_generated,
              consent_to_store_source, status, created_at
       from avatar_profiles where user_id = $1 and deleted_at is null
       order by created_at desc`,
      [principal.internalUserId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      ...(row.source_asset_id ? { sourceAssetId: row.source_asset_id } : {}),
      ...(row.display_asset_id ? { displayAssetId: row.display_asset_id } : {}),
      avatarType: row.avatar_type,
      style: row.style,
      aiGenerated: row.ai_generated,
      consentToStoreSource: row.consent_to_store_source,
      status: row.status,
      createdAt: row.created_at.toISOString()
    }));
  }

  assertWorkerToken(provided: string | undefined) {
    const expected = process.env.AI_WORKER_TOKEN?.trim();
    if (!expected || expected.length < 24) throw new ServiceUnavailableException("AI worker authentication is not configured.");
    if (!provided) throw new ForbiddenException("AI worker authentication failed.");
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
      throw new ForbiddenException("AI worker authentication failed.");
    }
  }

  async claimWorkerJob(workerId: string, capabilities: string[], leaseSeconds = 60) {
    const normalized = [...new Set(capabilities.filter((value): value is AiJobType => workerJobTypes.includes(value as AiJobType)))];
    if (!/^[a-zA-Z0-9._:-]{3,120}$/.test(workerId) || normalized.length === 0) {
      throw new BadRequestException("Worker identity or capabilities are invalid.");
    }
    const lease = Math.max(15, Math.min(120, leaseSeconds));
    const claimed = await this.database.transaction(async (client) => {
      await client.query(
        `insert into ai_workers (worker_id, capabilities, protocol_version, last_seen_at)
         values ($1, $2, 1, now())
         on conflict (worker_id) do update set capabilities = excluded.capabilities, last_seen_at = now()`,
        [workerId, normalized]
      );
      const candidate = await client.query<{ id: string; status: AiJob["status"] }>(
        `select id, status from ai_jobs
         where job_type = any($1::text[]) and attempt_count < max_attempts
           and ((status = 'queued' and available_at <= now())
             or (status = 'running' and lease_expires_at < now()))
         order by priority desc, available_at, created_at, id
         for update skip locked limit 1`,
        [normalized]
      );
      const row = candidate.rows[0];
      if (!row) return undefined;
      if (row.status === "running") {
        await client.query(
          `update ai_job_attempts set status = 'timed_out', finished_at = now(), error_code = 'lease_expired'
           where job_id = $1 and status = 'running'`,
          [row.id]
        );
      }
      const updated = await client.query<ClaimedJobRow>(
        `update ai_jobs job set status = 'running', attempt_count = attempt_count + 1,
           fencing_token = fencing_token + 1, lease_owner = $2,
           lease_expires_at = now() + make_interval(secs => $3),
           started_at = coalesce(started_at, now()), completed_at = null,
           progress = greatest(progress, 1), error_code = null, error_message = null
         from ai_model_configs config
         where job.id = $1 and config.id = job.model_config_id
         returning job.id, job.organization_id, job.requested_by, job.job_type,
           job.input_asset_id, job.space_id, job.input_json, job.attempt_count,
           job.fencing_token::text, job.lease_expires_at,
           config.capability, config.provider, config.model_name, config.deployment_mode`,
        [row.id, workerId, lease]
      );
      const job = updated.rows[0]!;
      await client.query(
        `insert into ai_job_attempts (job_id, attempt_number, fencing_token, worker_id, status)
         values ($1, $2, $3, $4, 'running')`,
        [job.id, job.attempt_count, job.fencing_token, workerId]
      );
      return job;
    });
    if (!claimed) return { job: null, pollAfterMs: 1_500, protocolVersion };
    return { job: await this.workerProjection(claimed), pollAfterMs: 0, protocolVersion };
  }

  async heartbeatWorker(jobId: string, workerId: string, fencingToken: number, progress: number, leaseSeconds = 60) {
    const normalizedProgress = Math.max(1, Math.min(99, Math.round(progress)));
    const lease = Math.max(15, Math.min(120, leaseSeconds));
    const result = await this.database.query<{ lease_expires_at: Date }>(
      `update ai_jobs set progress = greatest(progress, $4),
         lease_expires_at = now() + make_interval(secs => $5)
       where id = $1 and status = 'running' and lease_owner = $2 and fencing_token = $3
         and lease_expires_at > now()
       returning lease_expires_at`,
      [jobId, workerId, fencingToken, normalizedProgress, lease]
    );
    if (!result.rowCount) throw new ConflictException("AI worker lease is stale.");
    await this.database.query("update ai_workers set last_seen_at = now() where worker_id = $1", [workerId]);
    return { leaseExpiresAt: result.rows[0]!.lease_expires_at.toISOString(), progress: normalizedProgress };
  }

  async completeWorkerJob(jobId: string, workerId: string, fencingToken: number, result: Record<string, unknown>) {
    await this.database.transaction(async (client) => {
      const job = await this.lockWorkerLease(client, jobId, workerId, fencingToken);
      const safeResult = await this.applyWorkerResult(client, job, result);
      await client.query(
        `update ai_jobs set status = 'succeeded', progress = 100, result_json = $4::jsonb,
           lease_owner = null, lease_expires_at = null, completed_at = now(),
           error_code = null, error_message = null
         where id = $1 and lease_owner = $2 and fencing_token = $3`,
        [jobId, workerId, fencingToken, JSON.stringify(safeResult)]
      );
      await client.query(
        `update ai_job_attempts set status = 'succeeded', finished_at = now()
         where job_id = $1 and fencing_token = $2 and status = 'running'`,
        [jobId, fencingToken]
      );
      await client.query("update ai_workers set last_seen_at = now() where worker_id = $1", [workerId]);
    });
    return { ok: true };
  }

  async failWorkerJob(jobId: string, workerId: string, fencingToken: number, input: {
    errorCode: string;
    errorMessage?: string;
    retryable: boolean;
  }) {
    if (!/^[a-z0-9_.-]{3,80}$/i.test(input.errorCode)) throw new BadRequestException("Worker error code is invalid.");
    const next = await this.database.transaction(async (client) => {
      const job = await this.lockWorkerLease(client, jobId, workerId, fencingToken);
      const retry = input.retryable;
      const state = await client.query<{ status: AiJob["status"] }>(
        `update ai_jobs set status = case when $4 and attempt_count < max_attempts then 'queued' else 'failed' end,
           available_at = case when $4 and attempt_count < max_attempts then now() + interval '2 seconds' else available_at end,
           lease_owner = null, lease_expires_at = null, progress = 0,
           error_code = $5, error_message = $6,
           completed_at = case when $4 and attempt_count < max_attempts then null else now() end
         where id = $1 and lease_owner = $2 and fencing_token = $3 returning status`,
        [jobId, workerId, fencingToken, retry, input.errorCode, input.errorMessage?.slice(0, 500) ?? null]
      );
      await client.query(
        `update ai_job_attempts set status = 'failed', error_code = $3, finished_at = now()
         where job_id = $1 and fencing_token = $2 and status = 'running'`,
        [jobId, fencingToken, input.errorCode]
      );
      return { jobType: job.job_type, status: state.rows[0]!.status };
    });
    if (next.status === "queued") await this.dispatch.notify(jobId, next.jobType);
    return { ok: true, status: next.status };
  }

  async workerInput(jobId: string, workerId: string, fencingToken: number) {
    const result = await this.database.query<{
      detected_mime_type: string;
      original_file_name: string;
      original_object_key: string;
      size_bytes: string;
    }>(
      `select asset.original_object_key, asset.original_file_name, asset.detected_mime_type, asset.size_bytes
       from ai_jobs job join media_assets asset on asset.id = job.input_asset_id
       where job.id = $1 and job.status = 'running' and job.lease_owner = $2
         and job.fencing_token = $3 and job.lease_expires_at > now()
         and asset.deleted_at is null and asset.processing_status = 'ready' and asset.virus_scan_status = 'clean'`,
      [jobId, workerId, fencingToken]
    );
    const row = result.rows[0];
    if (!row) throw new ConflictException("AI worker input lease is stale or unavailable.");
    return {
      fileName: row.original_file_name,
      mimeType: row.detected_mime_type,
      sizeBytes: Number(row.size_bytes),
      stream: this.objects.createReadStream(row.original_object_key)
    };
  }

  async ingestWorkerOutput(
    jobId: string,
    workerId: string,
    fencingToken: number,
    fileName: string,
    mimeType: string,
    input: Readable
  ) {
    const lease = await this.database.query<WorkerLease>(
      `select id, organization_id, requested_by, job_type, input_asset_id, input_json,
              model_config_id, fencing_token::text
       from ai_jobs where id = $1 and status = 'running' and lease_owner = $2
         and fencing_token = $3 and lease_expires_at > now()`,
      [jobId, workerId, fencingToken]
    );
    const job = lease.rows[0];
    if (!job || !["tts", "avatar_generation"].includes(job.job_type)) {
      throw new ConflictException("AI output upload lease is stale or unsupported.");
    }
    const normalizedName = sanitizeFileName(fileName);
    const objectKey = `ai-generated/${job.organization_id}/${jobId}/${randomUUID()}-${normalizedName}`;
    try {
      const stored = await this.objects.writeStream(objectKey, input, 25 * 1024 * 1024);
      await this.objects.fsync(objectKey);
      const inspection = await this.inspector.inspect(objectKey, normalizedName, mimeType);
      const expectedKind = job.job_type === "tts" ? "audio" : "image";
      if (inspection.blockedCode || inspection.mediaKind !== expectedKind) {
        throw new BadRequestException(`AI output must be a clean ${expectedKind} asset.`);
      }
      const assetId = randomUUID();
      await this.database.transaction(async (client) => {
        await this.lockWorkerLease(client, jobId, workerId, fencingToken);
        await client.query(
          `insert into media_assets (
             id, organization_id, owner_id, original_object_key, original_file_name,
             declared_mime_type, detected_mime_type, media_kind, size_bytes, sha256_hex,
             archive_scope, processing_status, preview_status, virus_scan_status,
             scan_engine, scan_summary, source, private_metadata_json, generated_by_job_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             'private_archive', 'ready', 'ready', 'clean', $11, $12, 'ai_generated', $13::jsonb, $14)`,
          [
            assetId,
            job.organization_id,
            job.requested_by,
            stored.objectKey,
            normalizedName,
            mimeType,
            inspection.detectedMimeType,
            inspection.mediaKind,
            stored.sizeBytes,
            stored.sha256Hex,
            inspection.scanEngine,
            inspection.scanSummary,
            JSON.stringify({ aiGenerated: true, jobType: job.job_type }),
            jobId
          ]
        );
      });
      return { assetId, contentUrl: `/media/assets/${assetId}/content?variant=original` };
    } catch (error) {
      await this.objects.remove(objectKey).catch(() => undefined);
      throw error;
    }
  }

  private async createJob(principal: AuthPrincipal, spec: CreateJobSpec): Promise<AiJob> {
    if (spec.idempotencyKey.length < 8 || spec.idempotencyKey.length > 160) {
      throw new BadRequestException("AI idempotency key must be between 8 and 160 characters.");
    }
    const requestHash = stableHash({ jobType: spec.jobType, ...spec.requestShape });
    const result = await this.database.transaction(async (client) => {
      const config = await this.modelConfig(client, spec.capability);
      const jobId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `insert into ai_jobs (
           id, organization_id, requested_by, model_config_id, job_type,
           input_asset_id, space_id, idempotency_key, request_hash, max_attempts, input_json
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         on conflict (requested_by, idempotency_key) do nothing returning id`,
        [
          jobId,
          principal.state.user.organizationId,
          principal.internalUserId,
          config.id,
          spec.jobType,
          spec.inputAssetId ?? null,
          spec.spaceId ?? null,
          spec.idempotencyKey,
          requestHash,
          spec.maxAttempts ?? 3,
          JSON.stringify(spec.inputJson)
        ]
      );
      if (!inserted.rowCount) {
        const existing = await client.query<{ id: string; request_hash: string }>(
          `select id, request_hash from ai_jobs where requested_by = $1 and idempotency_key = $2`,
          [principal.internalUserId, spec.idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash) {
          throw new ConflictException("AI idempotency key was already used with different input.");
        }
        return { created: false, id: row.id, status: undefined };
      }
      if (spec.prepare) await spec.prepare(client, jobId);
      const status = await client.query<{ status: AiJob["status"] }>("select status from ai_jobs where id = $1", [jobId]);
      await this.audit(client, principal, "ai.job.created", "ai_job", jobId, { jobType: spec.jobType });
      return { created: true, id: jobId, status: status.rows[0]!.status };
    });
    if (result.created && result.status === "queued") await this.dispatch.notify(result.id, spec.jobType);
    return this.ownedJob(principal, result.id);
  }

  private async ownedJob(principal: AuthPrincipal, jobId: string) {
    const result = await this.database.query<JobRow>(
      `${this.jobSelect()}
       where j.id = $1 and j.requested_by = $2 and j.organization_id = $3`,
      [jobId, principal.internalUserId, principal.state.user.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("AI job was not found.");
    return this.jobView(row);
  }

  private jobSelect() {
    return `select j.*, requester.public_id as requested_by_public_id,
      config.capability, config.provider, config.model_name, config.deployment_mode,
      transcript.id as transcript_id, transcript.ai_job_id as transcript_ai_job_id,
      transcript.source_asset_id as transcript_source_asset_id,
      transcript.language as transcript_language, transcript.draft_text as transcript_draft_text,
      transcript.edited_text as transcript_edited_text,
      transcript.review_status as transcript_review_status,
      transcript.approved_message_id as transcript_approved_message_id,
      transcript.created_at as transcript_created_at, transcript.updated_at as transcript_updated_at
      from ai_jobs j
      join users requester on requester.id = j.requested_by
      join ai_model_configs config on config.id = j.model_config_id
      left join voice_transcripts transcript on transcript.ai_job_id = j.id`;
  }

  private jobView(row: JobRow): AiJob {
    const transcript = row.transcript_id ? this.transcriptView({
      id: row.transcript_id,
      ai_job_id: row.transcript_ai_job_id!,
      source_asset_id: row.transcript_source_asset_id!,
      language: row.transcript_language!,
      draft_text: row.transcript_draft_text!,
      edited_text: row.transcript_edited_text,
      review_status: row.transcript_review_status!,
      approved_message_id: row.transcript_approved_message_id,
      created_at: row.transcript_created_at!,
      updated_at: row.transcript_updated_at!
    }) : undefined;
    return {
      id: row.id,
      organizationId: row.organization_id,
      requestedBy: row.requested_by_public_id,
      jobType: row.job_type,
      status: row.status,
      model: {
        capability: row.capability,
        deploymentMode: row.deployment_mode,
        name: row.model_name,
        provider: row.provider
      },
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      progress: row.progress,
      ...(row.input_asset_id ? { inputAssetId: row.input_asset_id } : {}),
      ...(row.space_id ? { spaceId: row.space_id } : {}),
      ...(row.result_json ? { resultJson: row.result_json } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {}),
      ...(transcript ? { transcript } : {}),
      createdAt: row.created_at.toISOString(),
      ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {})
    };
  }

  private async transcript(principal: AuthPrincipal, transcriptId: string) {
    const result = await this.database.query<{
      ai_job_id: string;
      approved_message_id: string | null;
      created_at: Date;
      draft_text: string;
      edited_text: string | null;
      id: string;
      language: string;
      review_status: VoiceTranscriptView["reviewStatus"];
      source_asset_id: string;
      updated_at: Date;
    }>(
      `select transcript.id, transcript.ai_job_id, transcript.source_asset_id, transcript.language,
              transcript.draft_text, transcript.edited_text, transcript.review_status,
              transcript.approved_message_id, transcript.created_at, transcript.updated_at
       from voice_transcripts transcript join ai_jobs job on job.id = transcript.ai_job_id
       where transcript.id = $1 and job.requested_by = $2 and job.organization_id = $3`,
      [transcriptId, principal.internalUserId, principal.state.user.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Transcript was not found.");
    return this.transcriptView(row);
  }

  private transcriptView(row: {
    ai_job_id: string;
    approved_message_id: string | null;
    created_at: Date;
    draft_text: string;
    edited_text: string | null;
    id: string;
    language: string;
    review_status: VoiceTranscriptView["reviewStatus"];
    source_asset_id: string;
    updated_at: Date;
  }): VoiceTranscriptView {
    return {
      id: row.id,
      aiJobId: row.ai_job_id,
      sourceAssetId: row.source_asset_id,
      language: row.language,
      draftText: row.draft_text,
      ...(row.edited_text ? { editedText: row.edited_text } : {}),
      reviewStatus: row.review_status,
      ...(row.approved_message_id ? { approvedMessageId: row.approved_message_id } : {}),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    };
  }

  private async workerProjection(row: ClaimedJobRow) {
    let input: Record<string, unknown> = { ...row.input_json };
    if (row.input_asset_id) input = { ...input, inputPath: `/internal/ai/jobs/${row.id}/input` };
    if (row.job_type === "summary") {
      const messages = await this.database.query<{
        body: string;
        created_at: Date;
        position: number;
        sender_public_id: string;
      }>(
        `select snapshot.position, message.body, message.created_at, sender.public_id as sender_public_id
         from ai_summary_inputs snapshot
         join messages message on message.id = snapshot.message_id
         join users sender on sender.id = message.sender_id
         where snapshot.job_id = $1 order by snapshot.position`,
        [row.id]
      );
      input = {
        ...input,
        messages: messages.rows.map((message) => ({
          body: message.body,
          createdAt: message.created_at.toISOString(),
          senderId: message.sender_public_id
        }))
      };
    }
    return {
      id: row.id,
      jobType: row.job_type,
      attemptNumber: row.attempt_count,
      fencingToken: Number(row.fencing_token),
      leaseExpiresAt: row.lease_expires_at.toISOString(),
      model: {
        capability: row.capability,
        deploymentMode: row.deployment_mode,
        name: row.model_name,
        provider: row.provider
      },
      input
    };
  }

  private async applyWorkerResult(client: PoolClient, job: WorkerLease, result: Record<string, unknown>) {
    if (job.job_type === "assistant") {
      throw new BadRequestException("Embedded assistant jobs cannot be completed by external workers.");
    }
    if (job.job_type === "stt") {
      const text = safeString(result.text, "STT result");
      const language = safeString(result.language ?? job.input_json.language ?? "ko", "STT language", 24);
      const segments = Array.isArray(result.segments) ? result.segments.slice(0, 10_000) : [];
      const transcriptId = randomUUID();
      await client.query(
        `insert into voice_transcripts (
           id, ai_job_id, source_asset_id, language, draft_text, segments_json, review_status
         ) values ($1, $2, $3, $4, $5, $6::jsonb, 'ai_draft')`,
        [transcriptId, job.id, job.input_asset_id, language, text, JSON.stringify(segments)]
      );
      return { aiGenerated: true, transcriptId };
    }
    if (job.job_type === "summary") {
      const summary = safeString(result.summary, "Summary result");
      const decisions = safeStringArray(result.decisions ?? [], "Summary decisions");
      const rawTasks = Array.isArray(result.tasks) ? result.tasks : [];
      if (rawTasks.length > 50) throw new BadRequestException("Summary tasks are invalid.");
      const tasks = rawTasks.map((task) => {
        if (!task || typeof task !== "object") throw new BadRequestException("Summary tasks are invalid.");
        const value = task as Record<string, unknown>;
        return {
          title: safeString(value.title, "Task title", 500),
          ...(typeof value.assignee === "string" && value.assignee.trim() ? { assignee: value.assignee.trim().slice(0, 120) } : {})
        };
      });
      return { aiGenerated: true, decisions, summary, tasks };
    }
    if (job.job_type === "tts") {
      const outputAssetId = safeString(result.outputAssetId, "TTS output asset", 36);
      await this.assertGeneratedOutput(client, job, outputAssetId, "audio");
      const textHash = safeString(job.input_json.textHash, "TTS text hash", 64);
      const settingsHash = safeString(job.input_json.settingsHash, "TTS settings hash", 64);
      const profileId = typeof job.input_json.voiceProfileId === "string" ? job.input_json.voiceProfileId : null;
      if (profileId) {
        const consent = await client.query(
          `select 1 from voice_profiles profile
           join voice_profile_consents voice_consent on voice_consent.id = profile.consent_id
           where profile.id = $1 and profile.subject_user_id = $2 and profile.status = 'active'
             and profile.watermark_required is true
             and voice_consent.status = 'active' and voice_consent.expires_at > now()`,
          [profileId, job.requested_by]
        );
        if (!consent.rowCount) throw new ForbiddenException("Voice consent is no longer active.");
      }
      const inserted = await client.query<{ id: string }>(
        `insert into tts_assets (
           ai_job_id, requested_by, voice_profile_id, model_config_id, text_hash,
           settings_hash, media_asset_id, watermarked, duration_ms
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (requested_by, text_hash, settings_hash, voice_profile_id, model_config_id) do nothing
         returning id`,
        [job.id, job.requested_by, profileId, job.model_config_id, textHash, settingsHash, outputAssetId, Boolean(profileId), Number(result.durationMs) || null]
      );
      if (!inserted.rowCount) {
        const cached = await client.query<{ media_asset_id: string }>(
          `select media_asset_id from tts_assets where requested_by = $1 and text_hash = $2
             and settings_hash = $3 and voice_profile_id is not distinct from $4::uuid and model_config_id = $5`,
          [job.requested_by, textHash, settingsHash, profileId, job.model_config_id]
        );
        await client.query("update media_assets set deleted_at = now() where id = $1", [outputAssetId]);
        return { aiGenerated: true, cacheHit: true, mediaAssetId: cached.rows[0]!.media_asset_id, watermarked: Boolean(profileId) };
      }
      return { aiGenerated: true, cacheHit: false, mediaAssetId: outputAssetId, watermarked: Boolean(profileId) };
    }
    if (job.job_type === "avatar_generation") {
      const outputAssetId = safeString(result.outputAssetId, "Avatar output asset", 36);
      await this.assertGeneratedOutput(client, job, outputAssetId, "image");
      const avatarId = safeString(job.input_json.avatarId, "Avatar id", 36);
      const updated = await client.query(
        `update avatar_profiles set display_asset_id = $2, status = 'active'
         where id = $1 and generation_job_id = $3 and status = 'pending'`,
        [avatarId, outputAssetId, job.id]
      );
      if (!updated.rowCount) throw new ConflictException("Avatar profile is no longer pending.");
      return { aiGenerated: true, avatarId, mediaAssetId: outputAssetId };
    }
    if (job.job_type === "voice_profile_enrollment") {
      const profileId = safeString(job.input_json.profileId, "Voice profile id", 36);
      const embeddingKey = safeString(result.encryptedEmbeddingKey, "Encrypted voice embedding key", 500);
      if (!embeddingKey.startsWith("vault://") || result.watermarked !== true) {
        throw new BadRequestException("Voice profile output must be encrypted and watermark-capable.");
      }
      const updated = await client.query(
        `update voice_profiles profile set status = 'active', encrypted_embedding_key = $2, activated_at = now()
         from voice_profile_consents consent
         where profile.id = $1 and profile.enrollment_job_id = $3 and profile.status = 'pending'
           and consent.id = profile.consent_id and consent.status = 'active' and consent.expires_at > now()`,
        [profileId, embeddingKey, job.id]
      );
      if (!updated.rowCount) throw new ForbiddenException("Voice consent is no longer active.");
      return { aiGenerated: true, profileId, watermarked: true };
    }
    const profileId = safeString(job.input_json.profileId, "Voice profile id", 36);
    await client.query(
      `update voice_profiles set status = 'deleted', encrypted_embedding_key = null, deleted_at = now()
       where id = $1 and subject_user_id = $2`,
      [profileId, job.requested_by]
    );
    return { deleted: true, profileId };
  }

  private async queueVoiceProfileDeletion(principal: AuthPrincipal, profileId: string) {
    const profile = await this.database.query<{ reference_asset_id: string }>(
      `select reference_asset_id from voice_profiles where id = $1 and subject_user_id = $2`,
      [profileId, principal.internalUserId]
    );
    if (!profile.rows[0]) return;
    await this.createJob(principal, {
      capability: "tts_voice_profile",
      inputJson: { profileId },
      jobType: "voice_profile_delete",
      idempotencyKey: `voice-delete-${profileId}`,
      requestShape: { profileId },
      prepare: async (client) => {
        await client.query("update voice_profiles set status = 'deleting' where id = $1 and status = 'revoked'", [profileId]);
      }
    });
  }

  private async voiceConsent(principal: AuthPrincipal, consentId: string): Promise<VoiceProfileConsentView> {
    const result = await this.database.query<{
      expires_at: Date;
      granted_at: Date;
      id: string;
      policy_version: string;
      purpose: "personal_tts";
      reference_asset_id: string;
      revoked_at: Date | null;
      status: VoiceProfileConsentView["status"];
    }>(
      `select id, reference_asset_id, purpose, policy_version, status, granted_at, expires_at, revoked_at
       from voice_profile_consents where id = $1 and subject_user_id = $2 and organization_id = $3`,
      [consentId, principal.internalUserId, principal.state.user.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Voice consent was not found.");
    return {
      id: row.id,
      referenceAssetId: row.reference_asset_id,
      purpose: row.purpose,
      policyVersion: row.policy_version,
      status: row.status,
      grantedAt: row.granted_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {})
    };
  }

  private async voiceProfileByEnrollmentJob(principal: AuthPrincipal, jobId: string) {
    const result = await this.database.query<{ id: string }>(
      `select id from voice_profiles where enrollment_job_id = $1 and subject_user_id = $2`,
      [jobId, principal.internalUserId]
    );
    if (!result.rows[0]) throw new NotFoundException("Voice profile was not found.");
    return this.voiceProfile(principal, result.rows[0].id);
  }

  private async voiceProfile(principal: AuthPrincipal, profileId: string): Promise<VoiceProfileView> {
    const result = await this.database.query<{
      consent_id: string;
      created_at: Date;
      deleted_at: Date | null;
      id: string;
      model_name: string;
      reference_asset_id: string;
      revoked_at: Date | null;
      status: VoiceProfileView["status"];
    }>(
      `select profile.id, profile.reference_asset_id, profile.consent_id, profile.status,
              profile.created_at, profile.revoked_at, profile.deleted_at, config.model_name
       from voice_profiles profile join ai_model_configs config on config.id = profile.model_config_id
       where profile.id = $1 and profile.subject_user_id = $2 and profile.organization_id = $3`,
      [profileId, principal.internalUserId, principal.state.user.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Voice profile was not found.");
    return {
      id: row.id,
      referenceAssetId: row.reference_asset_id,
      consentId: row.consent_id,
      modelName: row.model_name,
      status: row.status,
      watermarkRequired: true,
      createdAt: row.created_at.toISOString(),
      ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
      ...(row.deleted_at ? { deletedAt: row.deleted_at.toISOString() } : {})
    };
  }

  private async modelConfig(client: PoolClient, capability: ModelCapability) {
    const result = await client.query<{ id: string; minimum_version: string | null; model_family: string }>(
      `select id, model_family, minimum_version from ai_model_configs
       where capability = $1 and enabled is true order by created_at limit 1`,
      [capability]
    );
    const row = result.rows[0];
    if (!row) throw new ServiceUnavailableException(`AI capability ${capability} is not configured.`);
    if (capability === "summary" && (row.model_family !== "qwen" || !["3.5", "3.6"].includes(row.minimum_version ?? ""))) {
      throw new ServiceUnavailableException("Summary requires Qwen 3.5 or newer.");
    }
    return row;
  }

  private async assertAssetAccess(
    client: PoolClient,
    principal: AuthPrincipal,
    assetId: string,
    expectedKind: "audio" | "image",
    ownerOnly: boolean
  ) {
    const result = await client.query<{ media_kind: string; owner_id: string }>(
      `select asset.owner_id, asset.media_kind
       from media_assets asset
       left join lateral (
         select bool_or(g.can_preview) as can_preview
         from media_grants g
         join message_deliveries delivery on delivery.message_id = g.message_id
           and delivery.recipient_id = $2 and delivery.revoked_at is null
         where g.asset_id = asset.id and g.grantee_id = $2 and g.revoked_at is null
       ) access on true
       where asset.id = $1 and asset.organization_id = $3 and asset.deleted_at is null
         and asset.processing_status = 'ready' and asset.virus_scan_status = 'clean'
         and (asset.owner_id = $2 or (not $4 and coalesce(access.can_preview, false)))`,
      [assetId, principal.internalUserId, principal.state.user.organizationId, ownerOnly]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("AI input media asset was not found.");
    if (row.media_kind !== expectedKind) throw new BadRequestException(`AI input must be ${expectedKind}.`);
    if (ownerOnly && row.owner_id !== principal.internalUserId) throw new ForbiddenException("AI biometric source must be owned by its subject.");
  }

  private async assertSpaceMembership(client: PoolClient, principal: AuthPrincipal, spaceId: string) {
    const result = await client.query(
      `select 1 from conversation_spaces space
       join space_memberships membership on membership.space_id = space.id
       where space.id = $1 and space.organization_id = $2 and membership.user_id = $3
         and membership.status in ('active', 'muted') and space.archived_at is null`,
      [spaceId, principal.state.user.organizationId, principal.internalUserId]
    );
    if (!result.rowCount) throw new NotFoundException("Conversation was not found.");
  }

  private async assertActiveVoiceProfile(client: PoolClient, principal: AuthPrincipal, profileId: string) {
    const result = await client.query(
      `select 1 from voice_profiles profile
       join voice_profile_consents consent on consent.id = profile.consent_id
       where profile.id = $1 and profile.subject_user_id = $2 and profile.organization_id = $3
         and profile.status = 'active' and profile.watermark_required is true
         and consent.status = 'active' and consent.expires_at > now()`,
      [profileId, principal.internalUserId, principal.state.user.organizationId]
    );
    if (!result.rowCount) throw new ForbiddenException("An active consented voice profile is required.");
  }

  private async assertGeneratedOutput(client: PoolClient, job: WorkerLease, assetId: string, mediaKind: "audio" | "image") {
    const result = await client.query(
      `select 1 from media_assets where id = $1 and generated_by_job_id = $2
         and owner_id = $3 and organization_id = $4 and media_kind = $5
         and deleted_at is null and processing_status = 'ready' and virus_scan_status = 'clean'`,
      [assetId, job.id, job.requested_by, job.organization_id, mediaKind]
    );
    if (!result.rowCount) throw new BadRequestException("AI output asset is missing or does not match this job.");
  }

  private async lockOwnedJob(client: PoolClient, principal: AuthPrincipal, jobId: string) {
    const result = await client.query<{ job_type: AiJobType; status: AiJob["status"] }>(
      `select job_type, status from ai_jobs where id = $1 and requested_by = $2 and organization_id = $3 for update`,
      [jobId, principal.internalUserId, principal.state.user.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("AI job was not found.");
    return row;
  }

  private async lockWorkerLease(client: PoolClient, jobId: string, workerId: string, fencingToken: number) {
    const result = await client.query<WorkerLease>(
      `select id, organization_id, requested_by, job_type, input_asset_id, input_json,
              model_config_id, fencing_token::text
       from ai_jobs where id = $1 and status = 'running' and lease_owner = $2
         and fencing_token = $3 and lease_expires_at > now() for update`,
      [jobId, workerId, fencingToken]
    );
    const row = result.rows[0];
    if (!row) throw new ConflictException("AI worker lease is stale.");
    return row;
  }

  private audit(
    client: PoolClient,
    principal: AuthPrincipal,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, string>
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [principal.state.user.organizationId, principal.internalUserId, action, targetType, targetId, JSON.stringify(metadata)]
    );
  }
}
