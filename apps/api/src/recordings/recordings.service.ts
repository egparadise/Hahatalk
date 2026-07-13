import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  findCharacterPreset,
  type RecordingConsentDecision,
  type RecordingConsentStatus,
  type RecordingStatus,
  type RecordingStopReason,
  type RecordingView
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";
import {
  LiveKitEgressProviderService,
  recordingPolicyVersion,
  type RecordingProviderState
} from "./livekit-egress-provider.service.js";

export type RecordingSessionKind = "ad_hoc" | "scheduled_meeting";

type SessionAccessRow = {
  created_by: string;
  organization_id: string;
  participant_role: string;
  participant_status: string;
  provider_room_name: string;
  session_kind: RecordingSessionKind;
  session_status: string;
};

type RecordingRow = {
  consent_completed_at: Date | null;
  ended_at: Date | null;
  failure_code: string | null;
  id: string;
  organization_id: string;
  output_duration_seconds: number | null;
  output_object_key: string;
  output_size_bytes: string | null;
  policy_version: string;
  provider_egress_id: string | null;
  provider_room_name: string;
  provider_status: string | null;
  requested_at: Date;
  requested_by: string;
  requester_character_id: string | null;
  requester_display_name: string;
  requester_public_id: string;
  session_kind: RecordingSessionKind;
  started_at: Date | null;
  status: RecordingStatus;
  stop_requested_at: Date | null;
};

type RecordingParticipantRow = {
  character_id: string | null;
  consent_record_id: string | null;
  consent_status: Exclude<RecordingConsentStatus, "not_requested">;
  display_name: string;
  participant_role: string;
  public_id: string;
  responded_at: Date | null;
  user_id: string;
};

const activeRequestStatuses = new Set<RecordingStatus>([
  "consent_pending",
  "consent_granted",
  "starting",
  "recording",
  "stopping"
]);
@Injectable()
export class RecordingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecordingsService.name);
  private reconciliationTimer?: NodeJS.Timeout;
  private reconciling = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly provider: LiveKitEgressProviderService
  ) {}

  onModuleInit() {
    this.reconciliationTimer = setInterval(() => void this.reconcileOpenRecordings(), 5_000);
    this.reconciliationTimer.unref();
  }

  onModuleDestroy() {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
  }

  capabilities() {
    return this.provider.capabilities();
  }

  async request(principal: AuthPrincipal, sessionId: string, sessionKind: RecordingSessionKind) {
    if (!this.provider.capabilities().available) {
      throw new ServiceUnavailableException("Recording is not configured.");
    }
    try {
      await this.database.transaction(async (client) => {
        const session = await this.lockSession(client, principal, sessionId, sessionKind);
        this.assertModerator(session);
        if (session.session_status !== "active" || session.participant_status !== "joined") {
          throw new ConflictException("Join the active media session before requesting recording.");
        }
        const existing = await client.query<{ id: string }>(
          `select id from call_recordings
           where call_session_id = $1
             and status in ('consent_pending', 'consent_granted', 'starting', 'recording', 'stopping')
           for update`,
          [sessionId]
        );
        if (existing.rowCount) throw new ConflictException("A recording request is already open.");
        const participants = await client.query<{ role: string; user_id: string }>(
          `select user_id, role from call_participants
           where call_session_id = $1 and status = 'joined'
           order by user_id for update`,
          [sessionId]
        );
        if (!participants.rowCount) throw new ConflictException("No connected participants can consent to recording.");
        const recordingId = randomUUID();
        const outputObjectKey = `recordings/${session.organization_id}/${sessionId}/${recordingId}.mp4`;
        await client.query(
          `insert into call_recordings (
             id, organization_id, call_session_id, requested_by, status,
             policy_version, output_object_key
           ) values ($1, $2, $3, $4, 'consent_pending', $5, $6)`,
          [recordingId, session.organization_id, sessionId, principal.internalUserId, recordingPolicyVersion, outputObjectKey]
        );
        for (const participant of participants.rows) {
          await client.query(
            `insert into call_recording_participants (recording_id, user_id, participant_role)
             values ($1, $2, $3)`,
            [recordingId, participant.user_id, participant.role]
          );
        }
        await this.event(client, sessionId, principal.internalUserId, "recording.consent_requested", {
          policyVersion: recordingPolicyVersion
        });
        await this.audit(client, session.organization_id, principal.internalUserId, recordingId, "recording.consent_requested", {
          policyVersion: recordingPolicyVersion,
          sessionKind
        });
        await this.enqueue(client, sessionId, sessionKind);
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictException("A recording request is already open.");
      }
      throw error;
    }
    return this.get(principal, sessionId, sessionKind);
  }

  async respond(
    principal: AuthPrincipal,
    sessionId: string,
    sessionKind: RecordingSessionKind,
    decision: RecordingConsentDecision,
    policyVersion: string
  ) {
    if (policyVersion !== recordingPolicyVersion) {
      throw new ConflictException("The recording policy changed. Review the current policy before responding.");
    }
    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, principal, sessionId, sessionKind);
      if (session.participant_status !== "joined") {
        throw new ConflictException("Only connected participants may respond to this recording request.");
      }
      const recording = await this.lockLatest(client, sessionId);
      if (!recording || recording.status !== "consent_pending") {
        throw new ConflictException("There is no recording consent request awaiting a response.");
      }
      if (recording.policy_version !== policyVersion) {
        throw new ConflictException("The recording policy changed. Review the current policy before responding.");
      }
      const participantResult = await client.query<RecordingParticipantRow>(
        `select rp.user_id, rp.participant_role, rp.consent_status, rp.consent_record_id,
                rp.responded_at, u.public_id, u.display_name,
                p.public_profile_json ->> 'characterId' as character_id
         from call_recording_participants rp
         join users u on u.id = rp.user_id
         left join profiles p on p.user_id = u.id
         where rp.recording_id = $1 and rp.user_id = $2 for update of rp`,
        [recording.id, principal.internalUserId]
      );
      const participant = participantResult.rows[0];
      if (!participant) throw new ForbiddenException("You were not included in this recording request.");
      if (participant.consent_status !== "pending") {
        if (participant.consent_status === decision) return;
        throw new ConflictException("Your recording decision has already been recorded.");
      }
      const consent = await client.query<{ id: string }>(
        `insert into consent_records (
           organization_id, subject_user_id, consent_type, scope_type, scope_id,
           decision, policy_version, evidence_json
         ) values ($1, $2, 'recording', 'call_recording', $3, $4, $5, $6::jsonb)
         returning id`,
        [
          session.organization_id,
          principal.internalUserId,
          recording.id,
          decision,
          policyVersion,
          JSON.stringify({ source: "recording_consent_dialog", sessionKind })
        ]
      );
      await client.query(
        `update call_recording_participants
         set consent_status = $3, consent_record_id = $4, responded_at = now()
         where recording_id = $1 and user_id = $2`,
        [recording.id, principal.internalUserId, decision, consent.rows[0]!.id]
      );
      if (decision === "denied") {
        await client.query(
          `update call_recordings
           set status = 'consent_denied', ended_at = now(), updated_at = now(), version = version + 1
           where id = $1`,
          [recording.id]
        );
      } else {
        const pending = await client.query<{ count: string }>(
          `select count(*)::text as count from call_recording_participants
           where recording_id = $1 and consent_status = 'pending'`,
          [recording.id]
        );
        if (pending.rows[0]?.count === "0") {
          const snapshot = await client.query<{ consent_record_id: string; user_id: string }>(
            `select user_id, consent_record_id from call_recording_participants
             where recording_id = $1 and consent_status = 'granted'
             order by user_id`,
            [recording.id]
          );
          await client.query(
            `update call_recordings
             set status = 'consent_granted', consent_completed_at = now(),
                 consent_snapshot_json = $2::jsonb, updated_at = now(), version = version + 1
             where id = $1`,
            [recording.id, JSON.stringify({ participants: snapshot.rows, policyVersion })]
          );
        }
      }
      await this.event(client, sessionId, principal.internalUserId, `recording.consent_${decision}`, {
        policyVersion
      });
      await this.audit(client, session.organization_id, principal.internalUserId, recording.id, `recording.consent_${decision}`, {
        policyVersion,
        sessionKind
      });
      await this.enqueue(client, sessionId, sessionKind);
    });
    return this.get(principal, sessionId, sessionKind);
  }

  async start(principal: AuthPrincipal, sessionId: string, sessionKind: RecordingSessionKind) {
    if (!this.provider.capabilities().available) {
      throw new ServiceUnavailableException("Recording is not configured.");
    }
    const prepared = await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, principal, sessionId, sessionKind);
      this.assertModerator(session);
      if (session.session_status !== "active" || session.participant_status !== "joined") {
        throw new ConflictException("Join the active media session before starting recording.");
      }
      const recording = await this.lockLatest(client, sessionId);
      if (!recording || recording.status !== "consent_granted") {
        throw new ConflictException("Every connected participant must consent before recording starts.");
      }
      const snapshot = await client.query<{ user_id: string }>(
        `select user_id from call_recording_participants
         where recording_id = $1 and consent_status = 'granted' order by user_id`,
        [recording.id]
      );
      const connected = await client.query<{ user_id: string }>(
        `select user_id from call_participants
         where call_session_id = $1 and status = 'joined' order by user_id for update`,
        [sessionId]
      );
      if (snapshot.rows.map((row) => row.user_id).join("|") !== connected.rows.map((row) => row.user_id).join("|")) {
        await client.query(
          `update call_recordings
           set status = 'aborted', failure_code = 'participant_set_changed', ended_at = now(),
               updated_at = now(), version = version + 1 where id = $1`,
          [recording.id]
        );
        await this.event(client, sessionId, principal.internalUserId, "recording.participant_set_changed");
        await this.audit(client, session.organization_id, principal.internalUserId, recording.id, "recording.participant_set_changed", {
          sessionKind
        });
        await this.enqueue(client, sessionId, sessionKind);
        return { invalid: true as const };
      }
      await client.query(
        `update call_recordings
         set status = 'starting', started_by = $2, provider_status = 'starting',
             updated_at = now(), version = version + 1 where id = $1`,
        [recording.id, principal.internalUserId]
      );
      await this.event(client, sessionId, principal.internalUserId, "recording.start_requested");
      await this.audit(client, session.organization_id, principal.internalUserId, recording.id, "recording.start_requested", {
        sessionKind
      });
      await this.enqueue(client, sessionId, sessionKind);
      return {
        invalid: false as const,
        objectKey: recording.output_object_key,
        recordingId: recording.id,
        roomName: session.provider_room_name
      };
    });
    if (prepared.invalid) {
      throw new ConflictException("The connected participant set changed. Request fresh recording consent.");
    }

    let providerState: RecordingProviderState;
    try {
      providerState = await this.provider.startRoomComposite({
        objectKey: prepared.objectKey,
        recordingId: prepared.recordingId,
        roomName: prepared.roomName
      });
    } catch {
      await this.failStart(prepared.recordingId, principal.internalUserId);
      throw new ServiceUnavailableException("The recording provider could not start. No recording is active.");
    }
    const applied = await this.applyProviderState(prepared.recordingId, providerState, principal.internalUserId);
    if (applied.mustStop) {
      await this.stopProviderOrFailClosed(prepared.recordingId, providerState.id, applied.roomName);
    }
    return this.get(principal, sessionId, sessionKind);
  }

  async stop(
    principal: AuthPrincipal,
    sessionId: string,
    sessionKind: RecordingSessionKind,
    reason: Extract<RecordingStopReason, "host_stopped" | "consent_revoked">
  ) {
    const prepared = await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, principal, sessionId, sessionKind);
      const recording = await this.lockLatest(client, sessionId);
      if (!recording || !activeRequestStatuses.has(recording.status)) {
        throw new ConflictException("There is no recording request to stop.");
      }
      const participant = await client.query<RecordingParticipantRow>(
        `select rp.user_id, rp.participant_role, rp.consent_status, rp.consent_record_id,
                rp.responded_at, u.public_id, u.display_name,
                p.public_profile_json ->> 'characterId' as character_id
         from call_recording_participants rp
         join users u on u.id = rp.user_id
         left join profiles p on p.user_id = u.id
         where rp.recording_id = $1 and rp.user_id = $2 for update of rp`,
        [recording.id, principal.internalUserId]
      );
      if (reason === "host_stopped") {
        this.assertModerator(session);
      } else {
        if (participant.rows[0]?.consent_status !== "granted") {
          throw new ForbiddenException("Only a participant who granted consent may revoke it.");
        }
        const consent = await client.query<{ id: string }>(
          `insert into consent_records (
             organization_id, subject_user_id, consent_type, scope_type, scope_id,
             decision, policy_version, evidence_json, revoked_at
           ) values ($1, $2, 'recording', 'call_recording', $3, 'revoked', $4, $5::jsonb, now())
           returning id`,
          [
            session.organization_id,
            principal.internalUserId,
            recording.id,
            recording.policy_version,
            JSON.stringify({ source: "recording_active_control", sessionKind })
          ]
        );
        await client.query(
          `update call_recording_participants
           set consent_status = 'revoked', consent_record_id = $3, responded_at = now()
           where recording_id = $1 and user_id = $2`,
          [recording.id, principal.internalUserId, consent.rows[0]!.id]
        );
      }

      if (["consent_pending", "consent_granted"].includes(recording.status)) {
        await client.query(
          `update call_recordings
           set status = 'aborted', stop_requested_by = $2, stop_reason = $3,
               stop_requested_at = now(), ended_at = now(), updated_at = now(), version = version + 1
           where id = $1`,
          [recording.id, principal.internalUserId, reason]
        );
      } else {
        await client.query(
          `update call_recordings
           set status = 'stopping', stop_requested_by = $2, stop_reason = $3,
               stop_requested_at = coalesce(stop_requested_at, now()), updated_at = now(), version = version + 1
           where id = $1`,
          [recording.id, principal.internalUserId, reason]
        );
      }
      await this.event(client, sessionId, principal.internalUserId, `recording.${reason}`);
      await this.audit(client, session.organization_id, principal.internalUserId, recording.id, `recording.${reason}`, {
        sessionKind
      });
      await this.enqueue(client, sessionId, sessionKind);
      return {
        providerEgressId: recording.provider_egress_id,
        recordingId: recording.id,
        roomName: session.provider_room_name,
        shouldStopProvider: !["consent_pending", "consent_granted"].includes(recording.status)
          && Boolean(recording.provider_egress_id)
      };
    });

    if (prepared.shouldStopProvider && prepared.providerEgressId) {
      await this.stopProviderOrFailClosed(prepared.recordingId, prepared.providerEgressId, prepared.roomName);
    }
    return this.get(principal, sessionId, sessionKind);
  }

  async get(principal: AuthPrincipal, sessionId: string, sessionKind: RecordingSessionKind) {
    return this.database.transaction(async (client) => {
      await this.lockSession(client, principal, sessionId, sessionKind, false);
      const recording = await this.project(client, sessionId, principal.internalUserId);
      if (!recording) throw new NotFoundException("No recording request was found.");
      return recording;
    });
  }

  async project(client: PoolClient, sessionId: string, viewerInternalId: string): Promise<RecordingView | undefined> {
    const recordingResult = await client.query<RecordingRow>(
      `select r.id, r.organization_id, r.requested_by, r.status, r.policy_version,
              r.output_object_key, r.provider_egress_id, r.provider_status,
              r.requested_at, r.consent_completed_at, r.started_at,
              r.stop_requested_at, r.ended_at, r.failure_code,
              r.output_size_bytes::text, r.output_duration_seconds,
              c.session_kind, c.provider_room_name,
              u.public_id as requester_public_id, u.display_name as requester_display_name,
              p.public_profile_json ->> 'characterId' as requester_character_id
       from call_recordings r
       join call_sessions c on c.id = r.call_session_id
       join users u on u.id = r.requested_by
       left join profiles p on p.user_id = u.id
       where r.call_session_id = $1
       order by r.requested_at desc, r.id desc limit 1`,
      [sessionId]
    );
    const recording = recordingResult.rows[0];
    if (!recording) return undefined;
    const participantResult = await client.query<RecordingParticipantRow>(
      `select rp.user_id, rp.participant_role, rp.consent_status, rp.consent_record_id,
              rp.responded_at, u.public_id, u.display_name,
              p.public_profile_json ->> 'characterId' as character_id
       from call_recording_participants rp
       join users u on u.id = rp.user_id
       left join profiles p on p.user_id = u.id
       where rp.recording_id = $1
       order by rp.created_at, rp.user_id`,
      [recording.id]
    );
    const sessionParticipant = await client.query<{ role: string; status: string }>(
      `select role, status from call_participants
       where call_session_id = $1 and user_id = $2`,
      [sessionId, viewerInternalId]
    );
    const viewer = sessionParticipant.rows[0];
    if (!viewer) throw new NotFoundException("Media session was not found.");
    const myConsent = participantResult.rows.find((row) => row.user_id === viewerInternalId);
    const moderator = recording.session_kind === "ad_hoc"
      ? viewer.role === "host"
      : ["host", "cohost"].includes(viewer.role);
    const allConsented = participantResult.rows.length > 0
      && participantResult.rows.every((participant) => participant.consent_status === "granted");
    return {
      allConsented,
      canRespond: recording.status === "consent_pending" && myConsent?.consent_status === "pending",
      canRevoke: ["consent_granted", "starting", "recording"].includes(recording.status)
        && myConsent?.consent_status === "granted",
      canStart: recording.status === "consent_granted" && allConsented && moderator && viewer.status === "joined",
      canStop: ["starting", "recording"].includes(recording.status) && moderator && viewer.status === "joined",
      ...(recording.consent_completed_at ? { consentCompletedAt: recording.consent_completed_at.toISOString() } : {}),
      ...(recording.ended_at ? { endedAt: recording.ended_at.toISOString() } : {}),
      ...(recording.failure_code ? { failureCode: recording.failure_code } : {}),
      id: recording.id,
      myConsentStatus: myConsent?.consent_status ?? "not_requested",
      participants: participantResult.rows.map((participant) => ({
        consentStatus: participant.consent_status,
        isSelf: participant.user_id === viewerInternalId,
        person: {
          character: findCharacterPreset(participant.character_id ?? ""),
          displayName: participant.display_name,
          id: participant.public_id
        },
        ...(participant.responded_at ? { respondedAt: participant.responded_at.toISOString() } : {}),
        role: participant.participant_role as "host" | "participant" | "cohost" | "speaker" | "attendee"
      })),
      policyVersion: recording.policy_version,
      requestedAt: recording.requested_at.toISOString(),
      requestedBy: {
        character: findCharacterPreset(recording.requester_character_id ?? ""),
        displayName: recording.requester_display_name,
        id: recording.requester_public_id
      },
      ...(recording.started_at ? { startedAt: recording.started_at.toISOString() } : {}),
      status: recording.status,
      ...(recording.stop_requested_at ? { stopRequestedAt: recording.stop_requested_at.toISOString() } : {})
    };
  }

  canRequest(sessionStatus: string, participantStatus: string, role: string, recording?: RecordingView) {
    const moderator = role === "host" || role === "cohost";
    return this.provider.capabilities().available
      && sessionStatus === "active"
      && participantStatus === "joined"
      && moderator
      && (!recording || !activeRequestStatuses.has(recording.status));
  }

  async assertJoinAllowed(client: PoolClient, sessionId: string, userId: string) {
    const recording = await client.query<{ consent_status: string | null; status: RecordingStatus }>(
      `select r.status, rp.consent_status
       from call_recordings r
       left join call_recording_participants rp on rp.recording_id = r.id and rp.user_id = $2
       where r.call_session_id = $1
         and r.status in ('consent_pending', 'consent_granted', 'starting', 'recording', 'stopping')
       order by r.requested_at desc limit 1`,
      [sessionId, userId]
    );
    const row = recording.rows[0];
    if (row && row.consent_status !== "granted") {
      throw new ConflictException("A recording consent cycle is active. Join after recording stops.");
    }
  }

  async stopForSession(sessionId: string, actorId: string | null) {
    const prepared = await this.database.transaction(async (client) => {
      const recording = await client.query<{
        id: string;
        organization_id: string;
        provider_egress_id: string | null;
        provider_room_name: string;
        session_kind: RecordingSessionKind;
        status: RecordingStatus;
      }>(
        `select r.id, r.organization_id, r.provider_egress_id, r.status,
                c.provider_room_name, c.session_kind
         from call_recordings r join call_sessions c on c.id = r.call_session_id
         where r.call_session_id = $1
           and r.status in ('consent_pending', 'consent_granted', 'starting', 'recording', 'stopping')
         order by r.requested_at desc limit 1 for update of r`,
        [sessionId]
      );
      const row = recording.rows[0];
      if (!row) return undefined;
      if (["consent_pending", "consent_granted"].includes(row.status)) {
        await client.query(
          `update call_recordings
           set status = 'aborted', stop_reason = 'session_ended', stop_requested_by = $2,
               stop_requested_at = now(), ended_at = now(), updated_at = now(), version = version + 1
           where id = $1`,
          [row.id, actorId]
        );
      } else {
        await client.query(
          `update call_recordings
           set status = 'stopping', stop_reason = 'session_ended', stop_requested_by = $2,
               stop_requested_at = coalesce(stop_requested_at, now()), updated_at = now(), version = version + 1
           where id = $1`,
          [row.id, actorId]
        );
      }
      await this.event(client, sessionId, actorId, "recording.session_end_requested");
      await this.audit(client, row.organization_id, actorId, row.id, "recording.session_end_requested", {
        sessionKind: row.session_kind
      });
      await this.enqueue(client, sessionId, row.session_kind);
      return row;
    });
    if (prepared?.provider_egress_id) {
      await this.stopProviderOrFailClosed(prepared.id, prepared.provider_egress_id, prepared.provider_room_name);
    }
  }

  async markSessionTerminated(
    client: PoolClient,
    sessionId: string,
    actorId: string | null,
    sessionKind: RecordingSessionKind
  ) {
    const recordings = await client.query<{ id: string; organization_id: string; provider_egress_id: string | null }>(
      `select id, organization_id, provider_egress_id from call_recordings
       where call_session_id = $1
         and status in ('consent_pending', 'consent_granted', 'starting', 'recording', 'stopping')
       for update`,
      [sessionId]
    );
    for (const recording of recordings.rows) {
      await client.query(
        `update call_recordings set
           status = case when provider_egress_id is null then 'aborted' else 'stopping' end,
           stop_reason = coalesce(stop_reason, 'session_ended'),
           stop_requested_by = coalesce(stop_requested_by, $2),
           stop_requested_at = coalesce(stop_requested_at, now()),
           ended_at = case when provider_egress_id is null then now() else ended_at end,
           updated_at = now(), version = version + 1
         where id = $1`,
        [recording.id, actorId]
      );
      await this.audit(client, recording.organization_id, actorId, recording.id, "recording.session_terminated", {
        sessionKind
      });
    }
    if (recordings.rowCount) {
      await this.event(client, sessionId, actorId, "recording.session_terminated");
    }
  }

  async handleProviderState(state: RecordingProviderState) {
    let recording = await this.database.query<{ id: string }>(
      "select id from call_recordings where provider_egress_id = $1",
      [state.id]
    );
    if (!recording.rows[0] && state.roomName) {
      recording = await this.database.query<{ id: string }>(
        `select r.id from call_recordings r
         join call_sessions c on c.id = r.call_session_id
         where c.provider_room_name = $1 and r.provider_egress_id is null
           and r.started_by is not null
           and r.status in ('starting', 'stopping', 'failed', 'aborted')
         order by r.updated_at desc limit 1`,
        [state.roomName]
      );
    }
    if (!recording.rows[0]) return;
    const applied = await this.applyProviderState(recording.rows[0].id, state, null);
    if (applied.mustStop) await this.stopProviderOrFailClosed(recording.rows[0].id, state.id, applied.roomName);
  }

  private async lockSession(
    client: PoolClient,
    principal: AuthPrincipal,
    sessionId: string,
    sessionKind: RecordingSessionKind,
    lock = true
  ) {
    const result = await client.query<SessionAccessRow>(
      `select c.organization_id, c.created_by, c.provider_room_name,
              c.session_kind, c.status as session_status,
              cp.role as participant_role, cp.status as participant_status
       from call_sessions c
       join call_participants cp on cp.call_session_id = c.id and cp.user_id = $2
       where c.id = $1 and c.organization_id = $3 and c.session_kind = $4
       ${lock ? "for update of c, cp" : ""}`,
      [sessionId, principal.internalUserId, principal.state.user.organizationId, sessionKind]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Media session was not found.");
    return row;
  }

  private lockLatest(client: PoolClient, sessionId: string) {
    return client.query<RecordingRow>(
      `select r.id, r.organization_id, r.requested_by, r.status, r.policy_version,
              r.output_object_key, r.provider_egress_id, r.provider_status,
              r.requested_at, r.consent_completed_at, r.started_at,
              r.stop_requested_at, r.ended_at, r.failure_code,
              r.output_size_bytes::text, r.output_duration_seconds,
              c.session_kind, c.provider_room_name,
              u.public_id as requester_public_id, u.display_name as requester_display_name,
              p.public_profile_json ->> 'characterId' as requester_character_id
       from call_recordings r
       join call_sessions c on c.id = r.call_session_id
       join users u on u.id = r.requested_by
       left join profiles p on p.user_id = u.id
       where r.call_session_id = $1
       order by r.requested_at desc, r.id desc limit 1 for update of r`,
      [sessionId]
    ).then((result) => result.rows[0]);
  }

  private assertModerator(session: SessionAccessRow) {
    const allowed = session.session_kind === "ad_hoc"
      ? session.participant_role === "host"
      : ["host", "cohost"].includes(session.participant_role);
    if (!allowed) throw new ForbiddenException("Only a call host or meeting moderator may manage recording.");
  }

  private async applyProviderState(recordingId: string, state: RecordingProviderState, actorId: string | null) {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        call_session_id: string;
        ended_at: Date | null;
        failure_code: string | null;
        organization_id: string;
        output_duration_seconds: number | null;
        output_size_bytes: string | null;
        provider_egress_id: string | null;
        provider_status: string | null;
        provider_room_name: string;
        session_kind: RecordingSessionKind;
        started_at: Date | null;
        status: RecordingStatus;
      }>(
        `select r.call_session_id, r.organization_id, r.provider_egress_id, r.provider_status, r.status,
                r.started_at, r.ended_at, r.failure_code,
                r.output_size_bytes::text, r.output_duration_seconds,
                c.provider_room_name, c.session_kind
         from call_recordings r join call_sessions c on c.id = r.call_session_id
         where r.id = $1 for update of r`,
        [recordingId]
      );
      const recording = result.rows[0];
      if (!recording) throw new NotFoundException("Recording was not found.");
      if (recording.provider_egress_id && recording.provider_egress_id !== state.id) {
        throw new ConflictException("Recording provider identity changed unexpectedly.");
      }
      const terminal = ["ready", "failed", "aborted", "consent_denied"].includes(recording.status);
      const mustStop = terminal || recording.status === "stopping";
      const nextStatus: RecordingStatus = terminal
        ? recording.status
        : state.status === "active"
        ? (mustStop ? "stopping" : "recording")
        : state.status === "starting"
          ? (mustStop ? "stopping" : "starting")
          : state.status === "ending"
            ? "stopping"
            : state.status === "complete"
              ? "ready"
              : state.status === "aborted"
                ? "aborted"
                : "failed";
      const expectedFailureCode = state.failureCode
        ?? (state.status === "limit_reached" ? "provider_limit_reached" : "provider_failed");
      const providerStateUnchanged = recording.provider_egress_id === state.id
        && recording.provider_status === state.status
        && recording.status === nextStatus
        && (state.startedAt === undefined || recording.started_at?.getTime() === state.startedAt.getTime())
        && (state.endedAt === undefined || recording.ended_at?.getTime() === state.endedAt.getTime())
        && (state.outputSizeBytes === undefined
          || (recording.output_size_bytes !== null && Number(recording.output_size_bytes) === state.outputSizeBytes))
        && (state.outputDurationSeconds === undefined || recording.output_duration_seconds === state.outputDurationSeconds)
        && (nextStatus !== "failed" || recording.failure_code === expectedFailureCode);
      if (providerStateUnchanged) {
        return { mustStop: mustStop && ["starting", "active"].includes(state.status), roomName: recording.provider_room_name };
      }
      await client.query(
        `update call_recordings set
           provider_egress_id = coalesce(provider_egress_id, $2),
           provider_status = $3,
           status = $4,
           started_at = coalesce(started_at, $5, case when $4 = 'recording' then now() else null end),
           ended_at = case when $4 in ('ready', 'failed', 'aborted') then coalesce($6, now()) else ended_at end,
           output_size_bytes = coalesce($7, output_size_bytes),
           output_duration_seconds = coalesce($8, output_duration_seconds),
           failure_code = case when $4 = 'failed' then coalesce($9, 'provider_failed') else failure_code end,
           updated_at = now(), version = version + 1
         where id = $1`,
        [
          recordingId,
          state.id,
          state.status,
          nextStatus,
          state.startedAt ?? null,
          state.endedAt ?? null,
          state.outputSizeBytes ?? null,
          state.outputDurationSeconds ?? null,
          state.failureCode ?? (state.status === "limit_reached" ? "provider_limit_reached" : null)
        ]
      );
      await this.event(client, recording.call_session_id, actorId, "recording.provider_state", { status: nextStatus });
      await this.audit(client, recording.organization_id, actorId, recordingId, "recording.provider_state", {
        sessionKind: recording.session_kind,
        status: nextStatus
      });
      await this.enqueue(client, recording.call_session_id, recording.session_kind);
      return { mustStop: mustStop && ["starting", "active"].includes(state.status), roomName: recording.provider_room_name };
    });
  }

  private async failStart(recordingId: string, actorId: string | null) {
    await this.database.transaction(async (client) => {
      const recording = await client.query<{
        call_session_id: string;
        organization_id: string;
        session_kind: RecordingSessionKind;
        status: RecordingStatus;
      }>(
        `select r.call_session_id, r.organization_id, r.status, c.session_kind
         from call_recordings r join call_sessions c on c.id = r.call_session_id
         where r.id = $1 for update of r`,
        [recordingId]
      );
      const row = recording.rows[0];
      if (!row || !["starting", "stopping"].includes(row.status)) return;
      const status = row.status === "stopping" ? "aborted" : "failed";
      await client.query(
        `update call_recordings
         set status = $2, provider_status = 'failed', failure_code = 'provider_start_failed',
             provider_recovery_checked_at = null,
             ended_at = now(), updated_at = now(), version = version + 1 where id = $1`,
        [recordingId, status]
      );
      await this.event(client, row.call_session_id, actorId, "recording.provider_start_failed");
      await this.audit(client, row.organization_id, actorId, recordingId, "recording.provider_start_failed", {
        sessionKind: row.session_kind
      });
      await this.enqueue(client, row.call_session_id, row.session_kind);
    });
  }

  private async stopProviderOrFailClosed(recordingId: string, egressId: string, roomName: string) {
    try {
      const state = await this.provider.stop(egressId);
      await this.applyProviderState(recordingId, state, null);
    } catch {
      let roomDeleted = true;
      try {
        await this.provider.deleteRoom(roomName);
      } catch {
        roomDeleted = false;
      }
      await this.failClosed(recordingId, roomDeleted);
      throw new ServiceUnavailableException(
        roomDeleted
          ? "Recording stop was uncertain, so the media session was ended."
          : "Recording stop and media-room shutdown were uncertain. Contact an administrator immediately."
      );
    }
  }

  private async failClosed(recordingId: string, roomDeleted: boolean) {
    await this.database.transaction(async (client) => {
      const result = await client.query<{
        call_session_id: string;
        organization_id: string;
        session_kind: RecordingSessionKind;
      }>(
        `select r.call_session_id, r.organization_id, c.session_kind
         from call_recordings r join call_sessions c on c.id = r.call_session_id
         where r.id = $1 for update of r, c`,
        [recordingId]
      );
      const recording = result.rows[0];
      if (!recording) return;
      const failureCode = roomDeleted ? "provider_stop_uncertain" : "provider_stop_and_room_delete_failed";
      await client.query(
        `update call_recordings
         set status = 'failed', provider_status = 'failed', failure_code = $2,
             ended_at = now(), updated_at = now(), version = version + 1 where id = $1`,
        [recordingId, failureCode]
      );
      await client.query(
        `update call_sessions
         set status = 'failed', ended_at = now(), end_reason = 'recording_stop_uncertain',
             version = version + 1, updated_at = now()
         where id = $1 and status not in ('ended', 'cancelled', 'failed', 'expired')`,
        [recording.call_session_id]
      );
      await client.query(
        `update call_participants set
           status = case when status = 'joined' then 'left' when status in ('connecting', 'waiting', 'admitted') then 'removed' else status end,
           left_at = case when status in ('joined', 'connecting', 'waiting', 'admitted') then now() else left_at end,
           screen_share_status = 'off',
           screen_share_ended_at = case when screen_share_status <> 'off' then now() else screen_share_ended_at end,
           token_version = token_version + 1, updated_at = now()
         where call_session_id = $1`,
        [recording.call_session_id]
      );
      await this.event(client, recording.call_session_id, null, "recording.fail_closed", { roomDeleted });
      await this.audit(client, recording.organization_id, null, recordingId, "recording.fail_closed", {
        roomDeleted,
        sessionKind: recording.session_kind
      });
      await this.enqueue(client, recording.call_session_id, recording.session_kind);
    });
  }

  private async reconcileOpenRecordings() {
    if (this.reconciling || !this.provider.capabilities().available) return;
    this.reconciling = true;
    try {
      const rows = await this.database.query<{
        id: string;
        provider_egress_id: string | null;
        provider_room_name: string;
        status: RecordingStatus;
        updated_at: Date;
      }>(
        `select r.id, r.provider_egress_id, r.status, r.updated_at, c.provider_room_name
         from call_recordings r join call_sessions c on c.id = r.call_session_id
         where (
           r.provider_egress_id is not null
           and r.status in ('starting', 'recording', 'stopping', 'processing')
         ) or (
           r.provider_egress_id is null and r.started_by is not null and (
             (r.status in ('starting', 'stopping') and (
               r.provider_recovery_checked_at is null
               or r.provider_recovery_checked_at < now() - interval '15 seconds'
             ))
             or (r.status in ('failed', 'aborted') and r.provider_recovery_checked_at is null)
           )
         )
         order by r.updated_at desc limit 20`
      );
      for (const row of rows.rows) {
        try {
          if (row.provider_egress_id) {
            const state = await this.provider.get(row.provider_egress_id);
            if (state) await this.handleProviderState(state);
            continue;
          }
          const recovered = await this.provider.findActiveForRoom(row.provider_room_name);
          if (recovered) {
            await this.handleProviderState(recovered);
          } else if (["starting", "stopping"].includes(row.status)
            && Date.now() - row.updated_at.getTime() >= 30_000) {
            await this.failStart(row.id, null);
          } else {
            await this.database.query(
              "update call_recordings set provider_recovery_checked_at = now() where id = $1 and provider_egress_id is null",
              [row.id]
            );
          }
        } catch (error) {
          this.logger.warn(`Recording reconciliation deferred: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async enqueue(client: PoolClient, sessionId: string, sessionKind: RecordingSessionKind) {
    const recipients = await client.query<{ user_id: string }>(
      "select user_id from call_participants where call_session_id = $1 order by user_id",
      [sessionId]
    );
    const realtimeEvent = sessionKind === "ad_hoc" ? "call:recording-updated" : "meeting:recording-updated";
    for (const recipient of recipients.rows) {
      await client.query(
        `insert into outbox_events (aggregate_type, aggregate_id, event_type, payload_json)
         values ($1, $2, 'recording.updated', $3::jsonb)`,
        [
          sessionKind === "ad_hoc" ? "call" : "meeting",
          sessionId,
          JSON.stringify({
            recipientInternalId: recipient.user_id,
            realtimeEvent,
            realtimePayload: { sessionId }
          })
        ]
      );
    }
  }

  private event(
    client: PoolClient,
    sessionId: string,
    actorId: string | null,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ) {
    return client.query(
      `insert into call_events (call_session_id, actor_id, event_type, metadata_json)
       values ($1, $2, $3, $4::jsonb)`,
      [sessionId, actorId, eventType, JSON.stringify(metadata)]
    );
  }

  private audit(
    client: PoolClient,
    organizationId: string,
    actorId: string | null,
    recordingId: string,
    action: string,
    metadata: Record<string, unknown> = {}
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, 'call_recording', $4, $5::jsonb)`,
      [organizationId, actorId, action, recordingId, JSON.stringify(metadata)]
    );
  }
}
