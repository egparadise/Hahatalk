import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  findCharacterPreset,
  type CallCapabilities,
  type CallJoinView,
  type CallParticipantStatus,
  type CallStatus,
  type CallType,
  type CallView,
  type ConversationType,
  type MemberRole,
  type StartCallInput
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";
import { LiveKitProviderService } from "./livekit-provider.service.js";

type SpaceMemberRow = {
  display_name: string;
  internal_user_id: string;
  owner_id: string;
  public_id: string;
  role: MemberRole;
  space_name: string;
  space_type: ConversationType;
};

type CallRow = {
  call_type: CallType;
  created_at: Date;
  created_by: string;
  ended_at: Date | null;
  end_reason: string | null;
  expires_at: Date;
  id: string;
  organization_id: string;
  provider_room_name: string;
  space_id: string;
  space_name: string;
  space_owner_id: string;
  space_type: ConversationType;
  started_at: Date | null;
  status: CallStatus;
};

type ParticipantRow = {
  character_id: string | null;
  display_name: string;
  invited_at: Date;
  joined_at: Date | null;
  left_at: Date | null;
  provider_identity: string;
  public_id: string;
  role: "host" | "participant";
  status: CallParticipantStatus;
  user_id: string;
};

type LockedParticipantRow = {
  call_type: CallType;
  created_by: string;
  expires_at: Date;
  organization_id: string;
  participant_status: CallParticipantStatus;
  provider_identity: string;
  provider_room_name: string;
  role: "host" | "participant";
  status: CallStatus;
};

const terminalCallStatuses = new Set<CallStatus>(["ended", "cancelled", "failed", "expired"]);
const maximumCallParticipants = 16;
const ringTimeoutSeconds = 90;

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function opaqueName(prefix: string, bytes = 24) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

@Injectable()
export class CallsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly livekit: LiveKitProviderService
  ) {}

  capabilities(): CallCapabilities {
    return this.livekit.capabilities();
  }

  async start(principal: AuthPrincipal, input: StartCallInput): Promise<CallView> {
    if (!this.livekit.capabilities().available) {
      throw new ServiceUnavailableException("Voice and video calls are not configured.");
    }
    if (["guest", "subscriber"].includes(principal.state.role)) {
      throw new ForbiddenException("Guest accounts may join calls but cannot start them.");
    }

    const targetUserIds = [...new Set(input.targetUserIds)].sort();
    const requestHash = stableHash({
      callType: input.callType,
      spaceId: input.spaceId,
      targetUserIds
    });
    const prepared = await this.database.transaction(async (client) => {
      const members = await this.spaceMembers(client, principal, input.spaceId);
      const existing = await client.query<{ request_hash: string; response_json: { callId?: string } | null }>(
        `select request_hash, response_json from idempotency_keys
         where scope = 'call.start' and key = $1 and owner_id = $2`,
        [input.clientCallId, principal.internalUserId]
      );
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        if (row.request_hash !== requestHash) {
          throw new ConflictException("Idempotency key was already used with a different call.");
        }
        if (!row.response_json?.callId) {
          throw new ConflictException("The original call request is still being processed.");
        }
        return { callId: row.response_json.callId, replay: true };
      }

      const targets = this.resolveTargets(principal, members, targetUserIds);
      const claimed = await client.query(
        `insert into idempotency_keys (scope, key, owner_id, request_hash, expires_at)
         values ('call.start', $1, $2, $3, now() + interval '1 day')
         on conflict do nothing returning key`,
        [input.clientCallId, principal.internalUserId, requestHash]
      );
      if (!claimed.rowCount) {
        throw new ConflictException("The call request is already being processed.");
      }

      const callId = randomUUID();
      const providerRoomName = opaqueName("hht_call");
      await client.query(
        `insert into call_sessions (
           id, organization_id, space_id, created_by, call_type,
           provider_room_name, status, expires_at
         ) values ($1, $2, $3, $4, $5, $6, 'starting', now() + make_interval(secs => $7))`,
        [
          callId,
          principal.state.user.organizationId,
          input.spaceId,
          principal.internalUserId,
          input.callType,
          providerRoomName,
          ringTimeoutSeconds
        ]
      );
      const participants = [
        { internalId: principal.internalUserId, role: "host" as const },
        ...targets.map((target) => ({ internalId: target.internal_user_id, role: "participant" as const }))
      ];
      for (const participant of participants) {
        await client.query(
          `insert into call_participants (
             call_session_id, user_id, role, status, provider_identity,
             can_publish_audio, can_publish_video
           ) values ($1, $2, $3, 'invited', $4, true, $5)`,
          [callId, participant.internalId, participant.role, opaqueName("hht_media", 18), input.callType === "video"]
        );
      }
      await this.event(client, callId, principal.internalUserId, principal.internalUserId, "call.start_requested", {
        callType: input.callType,
        participantCount: participants.length
      });
      await this.audit(client, principal.state.user.organizationId, principal.internalUserId, callId, "call.start_requested", {
        callType: input.callType,
        participantCount: participants.length,
        spaceId: input.spaceId
      });
      await client.query(
        `update idempotency_keys set response_json = $4::jsonb, status_code = 201
         where scope = 'call.start' and key = $1 and owner_id = $2 and request_hash = $3`,
        [input.clientCallId, principal.internalUserId, requestHash, JSON.stringify({ callId })]
      );
      return { callId, replay: false };
    });

    try {
      await this.ensureProviderReady(prepared.callId);
    } catch {
      await this.failProviderStart(prepared.callId, principal.internalUserId);
      throw new ServiceUnavailableException("The call service could not start a media room. Try again.");
    }
    return this.get(principal, prepared.callId);
  }

  async list(principal: AuthPrincipal, spaceId: string): Promise<CallView[]> {
    await this.assertSpaceMembership(principal, spaceId);
    const due = await this.database.query<{ id: string }>(
      `select c.id
       from call_sessions c
       join call_participants cp on cp.call_session_id = c.id and cp.user_id = $1
       where c.space_id = $2 and c.organization_id = $3
         and c.session_kind = 'ad_hoc'
         and c.status in ('starting', 'ringing') and c.expires_at <= now()`,
      [principal.internalUserId, spaceId, principal.state.user.organizationId]
    );
    for (const row of due.rows) await this.expire(row.id);

    return this.database.transaction(async (client) => {
      const calls = await client.query<{ id: string }>(
        `select c.id
         from call_sessions c
         join call_participants cp on cp.call_session_id = c.id and cp.user_id = $1
         where c.space_id = $2 and c.organization_id = $3
           and c.session_kind = 'ad_hoc'
           and c.status in ('starting', 'ringing', 'active')
         order by c.created_at desc, c.id desc limit 20`,
        [principal.internalUserId, spaceId, principal.state.user.organizationId]
      );
      const views: CallView[] = [];
      for (const row of calls.rows) views.push(await this.project(client, row.id, principal.internalUserId));
      return views;
    });
  }

  async get(principal: AuthPrincipal, callId: string): Promise<CallView> {
    await this.expire(callId);
    return this.database.transaction((client) => this.project(client, callId, principal.internalUserId));
  }

  async join(principal: AuthPrincipal, callId: string): Promise<CallJoinView> {
    if (!this.livekit.capabilities().available) {
      throw new ServiceUnavailableException("Voice and video calls are not configured.");
    }
    await this.expire(callId);
    const prepared = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, callId);
      this.assertLiveCall(locked.status);
      if (["declined", "left", "removed", "missed"].includes(locked.participant_status)) {
        throw new ConflictException("This call invitation is no longer joinable.");
      }
      if (locked.participant_status === "invited") {
        await client.query(
          `update call_participants set status = 'connecting', connecting_at = now(), updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [callId, principal.internalUserId]
        );
        await this.event(client, callId, principal.internalUserId, principal.internalUserId, "call.participant_connecting");
        await this.audit(client, locked.organization_id, principal.internalUserId, callId, "call.participant_connecting");
        await this.enqueue(client, callId);
      }
      const displayName = principal.state.user.displayName;
      const call = await this.project(client, callId, principal.internalUserId);
      return { call, displayName, locked };
    });
    const credential = await this.livekit.joinCredential({
      callId,
      callType: prepared.locked.call_type,
      displayName: prepared.displayName,
      identity: prepared.locked.provider_identity,
      roomName: prepared.locked.provider_room_name
    });
    return {
      call: prepared.call,
      serverUrl: credential.serverUrl,
      token: credential.token,
      tokenExpiresAt: credential.expiresAt.toISOString()
    };
  }

  connected(principal: AuthPrincipal, callId: string): Promise<CallView> {
    return this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, callId);
      this.assertLiveCall(locked.status);
      if (!['connecting', 'joined'].includes(locked.participant_status)) {
        throw new ConflictException("A join credential must be requested before confirming connection.");
      }
      if (locked.participant_status !== "joined") {
        await client.query(
          `update call_participants
           set status = 'joined', joined_at = coalesce(joined_at, now()), left_at = null, updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [callId, principal.internalUserId]
        );
        await client.query(
          `update call_sessions
           set status = 'active', started_at = coalesce(started_at, now()), version = version + 1, updated_at = now()
           where id = $1 and status in ('starting', 'ringing', 'active')`,
          [callId]
        );
        await this.event(client, callId, principal.internalUserId, principal.internalUserId, "call.participant_joined");
        await this.audit(client, locked.organization_id, principal.internalUserId, callId, "call.participant_joined");
        await this.enqueue(client, callId);
      }
      return this.project(client, callId, principal.internalUserId);
    });
  }

  decline(principal: AuthPrincipal, callId: string): Promise<CallView> {
    return this.participantExit(principal, callId, "declined");
  }

  leave(principal: AuthPrincipal, callId: string): Promise<CallView> {
    return this.participantExit(principal, callId, "left");
  }

  async end(principal: AuthPrincipal, callId: string): Promise<CallView> {
    const result = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, callId);
      if (locked.role !== "host" || locked.created_by !== principal.internalUserId) {
        throw new ForbiddenException("Only the call host may end the call for everyone.");
      }
      if (!terminalCallStatuses.has(locked.status)) {
        await this.terminate(client, callId, principal.internalUserId, locked.organization_id, "ended", "host_ended");
      }
      return {
        providerRoomName: locked.provider_room_name,
        view: await this.project(client, callId, principal.internalUserId)
      };
    });
    await this.deleteProviderRoom(result.providerRoomName, callId);
    return result.view;
  }

  private async participantExit(
    principal: AuthPrincipal,
    callId: string,
    action: "declined" | "left"
  ): Promise<CallView> {
    await this.expire(callId);
    const result = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, callId);
      if (terminalCallStatuses.has(locked.status)) {
        return {
          ended: true,
          providerRoomName: locked.provider_room_name,
          view: await this.project(client, callId, principal.internalUserId)
        };
      }
      if (action === "declined") {
        if (locked.role === "host") throw new ForbiddenException("The host must end the call instead of declining it.");
        if (!['invited', 'connecting'].includes(locked.participant_status)) {
          throw new ConflictException("This call can no longer be declined.");
        }
        await client.query(
          `update call_participants
           set status = 'declined', declined_at = now(), updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [callId, principal.internalUserId]
        );
      } else {
        if (!['connecting', 'joined'].includes(locked.participant_status)) {
          throw new ConflictException("This participant is not connected to the call.");
        }
        await client.query(
          `update call_participants
           set status = 'left', left_at = now(), token_version = token_version + 1, updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [callId, principal.internalUserId]
        );
      }
      await this.event(client, callId, principal.internalUserId, principal.internalUserId, `call.participant_${action}`);
      await this.audit(client, locked.organization_id, principal.internalUserId, callId, `call.participant_${action}`);

      const remaining = await client.query<{ count: number }>(
        `select count(*)::int as count from call_participants
         where call_session_id = $1 and role = 'participant' and status in ('invited', 'connecting', 'joined')`,
        [callId]
      );
      const shouldEnd = locked.role === "host" || (remaining.rows[0]?.count ?? 0) === 0;
      if (shouldEnd) {
        await this.terminate(
          client,
          callId,
          principal.internalUserId,
          locked.organization_id,
          "ended",
          locked.role === "host" ? "host_left" : "no_participants"
        );
      } else {
        await this.enqueue(client, callId);
      }
      return {
        ended: shouldEnd,
        providerRoomName: locked.provider_room_name,
        view: await this.project(client, callId, principal.internalUserId)
      };
    });
    if (result.ended) await this.deleteProviderRoom(result.providerRoomName, callId);
    return result.view;
  }

  private async ensureProviderReady(callId: string) {
    const current = await this.database.query<{
      provider_room_name: string;
      status: CallStatus;
      participant_count: number;
    }>(
      `select c.provider_room_name, c.status, count(cp.user_id)::int as participant_count
       from call_sessions c join call_participants cp on cp.call_session_id = c.id
       where c.id = $1 and c.session_kind = 'ad_hoc' group by c.id`,
      [callId]
    );
    const row = current.rows[0];
    if (!row) throw new NotFoundException("Call was not found.");
    if (row.status !== "starting") return;
    await this.livekit.createRoom(row.provider_room_name, row.participant_count);
    await this.database.transaction(async (client) => {
      const updated = await client.query<{ organization_id: string; created_by: string }>(
        `update call_sessions
         set status = 'ringing', version = version + 1, updated_at = now()
         where id = $1 and status = 'starting'
         returning organization_id, created_by`,
        [callId]
      );
      if (!updated.rowCount) return;
      const call = updated.rows[0]!;
      await this.event(client, callId, call.created_by, call.created_by, "call.ringing");
      await this.audit(client, call.organization_id, call.created_by, callId, "call.ringing");
      await this.enqueue(client, callId, true);
    });
  }

  private async failProviderStart(callId: string, actorId: string) {
    await this.database.transaction(async (client) => {
      const updated = await client.query<{ organization_id: string }>(
        `update call_sessions
         set status = 'failed', ended_at = now(), end_reason = 'provider_unavailable',
             version = version + 1, updated_at = now()
         where id = $1 and session_kind = 'ad_hoc' and status = 'starting' returning organization_id`,
        [callId]
      );
      if (!updated.rowCount) return;
      await client.query(
        `update call_participants set status = 'missed', left_at = now(), updated_at = now()
         where call_session_id = $1 and status = 'invited'`,
        [callId]
      );
      await this.event(client, callId, actorId, actorId, "call.provider_start_failed", { provider: "livekit" });
      await this.audit(client, updated.rows[0]!.organization_id, actorId, callId, "call.provider_start_failed", { provider: "livekit" });
      await this.enqueue(client, callId, false, [actorId]);
    });
  }

  private async expire(callId: string) {
    const result = await this.database.transaction(async (client) => {
      const call = await client.query<{
        organization_id: string;
        provider_room_name: string;
        status: CallStatus;
      }>(
        `select organization_id, provider_room_name, status from call_sessions
         where id = $1 and session_kind = 'ad_hoc' for update`,
        [callId]
      );
      const row = call.rows[0];
      if (!row || !['starting', 'ringing'].includes(row.status)) return undefined;
      const updated = await client.query(
        `update call_sessions
         set status = 'expired', ended_at = now(), end_reason = 'ring_timeout',
             version = version + 1, updated_at = now()
         where id = $1 and expires_at <= now()`,
        [callId]
      );
      if (!updated.rowCount) return undefined;
      await client.query(
        `update call_participants
         set status = case
           when status = 'invited' then 'missed'
           when status = 'connecting' then 'removed'
           when status = 'joined' then 'left'
           else status end,
           left_at = case when status in ('connecting', 'joined') then now() else left_at end,
           token_version = token_version + 1,
           updated_at = now()
         where call_session_id = $1`,
        [callId]
      );
      await this.event(client, callId, null, null, "call.expired");
      await this.audit(client, row.organization_id, null, callId, "call.expired");
      await this.enqueue(client, callId);
      return row.provider_room_name;
    });
    if (result) await this.deleteProviderRoom(result, callId);
  }

  private async terminate(
    client: PoolClient,
    callId: string,
    actorId: string,
    organizationId: string,
    status: "ended" | "cancelled",
    reason: string
  ) {
    await client.query(
      `update call_sessions
       set status = $2, ended_at = now(), end_reason = $3, version = version + 1, updated_at = now()
       where id = $1 and status not in ('ended', 'cancelled', 'failed', 'expired')`,
      [callId, status, reason]
    );
    await client.query(
      `update call_participants
       set status = case
         when status = 'invited' then 'missed'
         when status in ('connecting', 'joined') and role = 'host' then 'left'
         when status in ('connecting', 'joined') then 'removed'
         else status end,
         left_at = case when status in ('connecting', 'joined') then now() else left_at end,
         token_version = token_version + 1,
         updated_at = now()
       where call_session_id = $1`,
      [callId]
    );
    await this.event(client, callId, actorId, actorId, `call.${status}`, { reason });
    await this.audit(client, organizationId, actorId, callId, `call.${status}`, { reason });
    await this.enqueue(client, callId);
  }

  private async deleteProviderRoom(roomName: string, callId: string) {
    try {
      await this.livekit.deleteRoom(roomName);
    } catch {
      await this.database.query(
        `insert into call_events (call_session_id, event_type, metadata_json)
         values ($1, 'call.provider_delete_failed', '{"provider":"livekit"}'::jsonb)`,
        [callId]
      ).catch(() => undefined);
    }
  }

  private async spaceMembers(client: PoolClient, principal: AuthPrincipal, spaceId: string) {
    const result = await client.query<SpaceMemberRow>(
      `select s.name as space_name, s.type as space_type, s.owner_id,
              sm.user_id as internal_user_id, sm.role, u.public_id, u.display_name
       from conversation_spaces s
       join space_memberships sm on sm.space_id = s.id and sm.status in ('active', 'muted')
       join users u on u.id = sm.user_id
       where s.id = $1 and s.organization_id = $2 and s.archived_at is null
       order by case sm.role when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end, sm.joined_at`,
      [spaceId, principal.state.user.organizationId]
    );
    if (!result.rows.some((row) => row.internal_user_id === principal.internalUserId && row.public_id === principal.state.user.id)) {
      throw new NotFoundException("Conversation membership was not found.");
    }
    return result.rows;
  }

  private resolveTargets(principal: AuthPrincipal, members: SpaceMemberRow[], targetUserIds: string[]) {
    const first = members[0];
    if (!first) throw new NotFoundException("Conversation was not found.");
    const others = members.filter((member) => member.internal_user_id !== principal.internalUserId);
    const requested = targetUserIds.map((id) => members.find((member) => member.public_id === id));
    if (requested.some((member) => !member || member.internal_user_id === principal.internalUserId)) {
      throw new BadRequestException("Call targets must be active members of this conversation.");
    }

    let targets: SpaceMemberRow[];
    if (first.space_type === "direct") {
      if (others.length !== 1) throw new ConflictException("Direct conversation membership is invalid.");
      if (requested.length && requested[0]?.internal_user_id !== others[0]!.internal_user_id) {
        throw new BadRequestException("A direct call may only invite the counterpart.");
      }
      targets = [others[0]!];
    } else if (first.space_type === "hub") {
      if (principal.internalUserId === first.owner_id) {
        if (requested.length !== 1) {
          throw new BadRequestException("A private hub call must select exactly one person.");
        }
        targets = [requested[0]!];
      } else {
        const owner = members.find((member) => member.internal_user_id === first.owner_id);
        if (!owner) throw new ConflictException("The hub owner membership is missing.");
        if (requested.length && (requested.length !== 1 || requested[0]?.internal_user_id !== owner.internal_user_id)) {
          throw new BadRequestException("A hub participant may only call the owner.");
        }
        targets = [owner];
      }
    } else if (first.space_type === "open_group") {
      targets = requested.length ? requested as SpaceMemberRow[] : others;
    } else {
      throw new BadRequestException("Ad-hoc calls are not available in this conversation type.");
    }

    if (!targets.length) throw new BadRequestException("Select at least one call participant.");
    if (targets.length + 1 > maximumCallParticipants) {
      throw new BadRequestException(`Calls are limited to ${maximumCallParticipants} participants in this stage.`);
    }
    return targets;
  }

  private async assertSpaceMembership(principal: AuthPrincipal, spaceId: string) {
    const result = await this.database.query(
      `select 1 from conversation_spaces s
       join space_memberships sm on sm.space_id = s.id
       where s.id = $1 and s.organization_id = $2 and s.archived_at is null
         and sm.user_id = $3 and sm.status in ('active', 'muted')`,
      [spaceId, principal.state.user.organizationId, principal.internalUserId]
    );
    if (!result.rowCount) throw new NotFoundException("Conversation membership was not found.");
  }

  private async lockParticipant(client: PoolClient, principal: AuthPrincipal, callId: string) {
    const result = await client.query<LockedParticipantRow>(
      `select c.organization_id, c.created_by, c.call_type, c.provider_room_name,
              c.status, c.expires_at, cp.role, cp.status as participant_status,
              cp.provider_identity
       from call_sessions c
       join call_participants cp on cp.call_session_id = c.id and cp.user_id = $2
       where c.id = $1 and c.organization_id = $3 and c.session_kind = 'ad_hoc'
       for update of c, cp`,
      [callId, principal.internalUserId, principal.state.user.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Call was not found.");
    return row;
  }

  private assertLiveCall(status: CallStatus) {
    if (terminalCallStatuses.has(status)) throw new ConflictException("This call has ended.");
  }

  private async project(client: PoolClient, callId: string, viewerInternalId: string): Promise<CallView> {
    const callResult = await client.query<CallRow>(
      `select c.id, c.organization_id, c.space_id, c.created_by, c.call_type,
              c.provider_room_name, c.status, c.expires_at, c.started_at,
              c.ended_at, c.end_reason, c.created_at,
              s.type as space_type, s.name as space_name, s.owner_id as space_owner_id
       from call_sessions c join conversation_spaces s on s.id = c.space_id
       where c.id = $1 and c.session_kind = 'ad_hoc'`,
      [callId]
    );
    const call = callResult.rows[0];
    if (!call) throw new NotFoundException("Call was not found.");
    const participantResult = await client.query<ParticipantRow>(
      `select cp.user_id, cp.role, cp.status, cp.provider_identity, cp.invited_at,
              cp.joined_at, cp.left_at, u.public_id, u.display_name,
              p.public_profile_json ->> 'characterId' as character_id
       from call_participants cp
       join users u on u.id = cp.user_id
       left join profiles p on p.user_id = u.id
       where cp.call_session_id = $1
       order by case cp.role when 'host' then 0 else 1 end, cp.invited_at, cp.user_id`,
      [callId]
    );
    const viewer = participantResult.rows.find((row) => row.user_id === viewerInternalId);
    if (!viewer) throw new NotFoundException("Call was not found.");
    const terminal = terminalCallStatuses.has(call.status);
    const counterpart = participantResult.rows.find((row) => row.user_id !== viewerInternalId);
    const title = call.space_type === "open_group"
      ? call.space_name
      : counterpart?.display_name ?? "HahaTalk call";
    return {
      callType: call.call_type,
      canDecline: !terminal && viewer.role !== "host" && ['invited', 'connecting'].includes(viewer.status),
      canEnd: !terminal && viewer.role === "host" && call.created_by === viewerInternalId,
      canJoin: !terminal && ['ringing', 'active'].includes(call.status) && ['invited', 'connecting', 'joined'].includes(viewer.status),
      canLeave: !terminal && ['connecting', 'joined'].includes(viewer.status),
      createdAt: call.created_at.toISOString(),
      ...(call.ended_at ? { endedAt: call.ended_at.toISOString() } : {}),
      ...(call.end_reason ? { endReason: call.end_reason } : {}),
      expiresAt: call.expires_at.toISOString(),
      id: call.id,
      isCreator: call.created_by === viewerInternalId,
      isIncoming: !terminal && viewer.role !== "host" && viewer.status === "invited",
      participants: participantResult.rows.map((participant) => ({
        invitedAt: participant.invited_at.toISOString(),
        isSelf: participant.user_id === viewerInternalId,
        ...(participant.joined_at ? { joinedAt: participant.joined_at.toISOString() } : {}),
        ...(participant.left_at ? { leftAt: participant.left_at.toISOString() } : {}),
        mediaIdentity: participant.provider_identity,
        person: {
          character: findCharacterPreset(participant.character_id ?? ""),
          displayName: participant.display_name,
          id: participant.public_id
        },
        role: participant.role,
        status: participant.status
      })),
      spaceId: call.space_id,
      ...(call.started_at ? { startedAt: call.started_at.toISOString() } : {}),
      status: call.status,
      title
    };
  }

  private async enqueue(
    client: PoolClient,
    callId: string,
    incoming = false,
    onlyInternalIds?: string[]
  ) {
    const recipients = onlyInternalIds
      ? onlyInternalIds.map((user_id) => ({ user_id }))
      : (await client.query<{ user_id: string }>(
          "select user_id from call_participants where call_session_id = $1 order by user_id",
          [callId]
        )).rows;
    for (const recipient of recipients) {
      const projection = await this.project(client, callId, recipient.user_id);
      await client.query(
        `insert into outbox_events (aggregate_type, aggregate_id, event_type, payload_json)
         values ('call', $1, 'call.session.updated', $2::jsonb)`,
        [callId, JSON.stringify({
          recipientInternalId: recipient.user_id,
          realtimeEvent: incoming && projection.isIncoming ? "call:incoming" : "call:updated",
          realtimePayload: projection
        })]
      );
    }
  }

  private event(
    client: PoolClient,
    callId: string,
    actorId: string | null,
    participantId: string | null,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ) {
    return client.query(
      `insert into call_events (call_session_id, actor_id, participant_id, event_type, metadata_json)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [callId, actorId, participantId, eventType, JSON.stringify(metadata)]
    );
  }

  private audit(
    client: PoolClient,
    organizationId: string,
    actorId: string | null,
    callId: string,
    action: string,
    metadata: Record<string, unknown> = {}
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, 'call_session', $4, $5::jsonb)`,
      [organizationId, actorId, action, callId, JSON.stringify(metadata)]
    );
  }
}
