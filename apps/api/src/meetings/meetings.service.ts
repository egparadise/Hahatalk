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
  type CalendarResponseStatus,
  type CallCapabilities,
  type CallType,
  type ConversationType,
  type MeetingJoinView,
  type MeetingParticipantStatus,
  type MeetingRole,
  type MeetingStatus,
  type MeetingView,
  type ScheduleMeetingInput,
  type ScreenShareStatus,
  type ScreenShareStopReason
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { LiveKitProviderService } from "../calls/livekit-provider.service.js";
import { localDateTimeToPseudoUtc, parseStoredRecurrence, recurrenceLocalStarts } from "../calendar/calendar-recurrence.js";
import { DatabaseService } from "../database/database.service.js";
import { RecordingsService } from "../recordings/recordings.service.js";

type EventRow = {
  all_day: boolean;
  created_by: string;
  ends_local_text: string;
  id: string;
  organization_id: string;
  recurrence_json: unknown;
  space_id: string;
  space_owner_id: string;
  space_type: ConversationType;
  starts_local_text: string;
  status: "scheduled" | "cancelled";
  timezone: string;
  title: string;
  version: number;
};

type EventAttendeeRow = {
  character_id: string | null;
  display_name: string;
  internal_user_id: string;
  organization_role: string;
  public_id: string;
  response_status: CalendarResponseStatus;
};

type MeetingRow = {
  call_type: CallType;
  created_at: Date;
  created_by: string;
  ended_at: Date | null;
  end_reason: string | null;
  event_id: string;
  expires_at: Date;
  id: string;
  lobby_opened_at: Date | null;
  lobby_opens_at: Date;
  occurrence_ends_at: Date;
  occurrence_starts_at: Date;
  organization_id: string;
  provider_room_name: string;
  space_id: string;
  space_owner_id: string;
  space_type: ConversationType;
  started_at: Date | null;
  status: MeetingStatus;
  title: string;
  version: number;
};

type MeetingParticipantRow = {
  admitted_at: Date | null;
  can_publish_audio: boolean;
  can_publish_video: boolean;
  character_id: string | null;
  display_name: string;
  event_response_status: CalendarResponseStatus;
  invited_at: Date;
  joined_at: Date | null;
  left_at: Date | null;
  provider_identity: string;
  public_id: string;
  role: MeetingRole;
  screen_share_started_at: Date | null;
  screen_share_status: ScreenShareStatus;
  status: MeetingParticipantStatus;
  user_id: string;
  waiting_at: Date | null;
};

type LockedMeetingParticipant = {
  call_type: CallType;
  can_publish_audio: boolean;
  can_publish_video: boolean;
  created_by: string;
  event_response_status: CalendarResponseStatus;
  expires_at: Date;
  lobby_opens_at: Date;
  occurrence_ends_at: Date;
  organization_id: string;
  participant_status: MeetingParticipantStatus;
  provider_identity: string;
  provider_room_name: string;
  role: MeetingRole;
  screen_share_status: ScreenShareStatus;
  status: MeetingStatus;
  version: number;
};

const terminalMeetingStatuses = new Set<MeetingStatus>(["ended", "cancelled", "failed", "expired"]);
const maximumMeetingParticipants = 50;
const lobbyLeadMilliseconds = 30 * 60_000;
const lobbyTailMilliseconds = 4 * 60 * 60_000;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function opaqueName(prefix: string, bytes = 24) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

@Injectable()
export class MeetingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly livekit: LiveKitProviderService,
    private readonly recordings: RecordingsService
  ) {}

  capabilities(): CallCapabilities {
    return this.livekit.capabilities();
  }

  async forOccurrence(principal: AuthPrincipal, eventId: string, rawOccurrenceStartsAt: string) {
    const occurrenceStartsAt = this.parseInstant(rawOccurrenceStartsAt, "Meeting occurrence");
    const authorized = await this.database.query(
      `select 1 from events e
       left join event_attendees ea
         on ea.event_id = e.id and ea.user_id = $2 and ea.revoked_at is null
       where e.id = $1 and e.organization_id = $3
         and (e.created_by = $2 or ea.user_id = $2)`,
      [eventId, principal.internalUserId, principal.state.user.organizationId]
    );
    if (!authorized.rowCount) throw new NotFoundException("Calendar event not found.");
    const result = await this.database.query<{ id: string }>(
      `select c.id from call_sessions c
       join call_participants cp on cp.call_session_id = c.id and cp.user_id = $3
       where c.event_id = $1 and c.occurrence_starts_at = $2
         and c.organization_id = $4 and c.session_kind = 'scheduled_meeting'`,
      [eventId, occurrenceStartsAt, principal.internalUserId, principal.state.user.organizationId]
    );
    const meetingId = result.rows[0]?.id;
    if (!meetingId) return null;
    await this.expire(meetingId);
    return this.database.transaction((client) => this.project(client, meetingId, principal.internalUserId));
  }

  async schedule(principal: AuthPrincipal, input: ScheduleMeetingInput): Promise<MeetingView> {
    if (!this.livekit.capabilities().available) {
      throw new ServiceUnavailableException("Scheduled meetings require a configured LiveKit service.");
    }
    if (["guest", "subscriber"].includes(principal.state.role)) {
      throw new ForbiddenException("Guest accounts cannot schedule meetings.");
    }
    const normalizedAssignments = [...input.roleAssignments]
      .sort((left, right) => left.userId.localeCompare(right.userId));
    if (new Set(normalizedAssignments.map((item) => item.userId)).size !== normalizedAssignments.length) {
      throw new BadRequestException("Each meeting participant may have only one role assignment.");
    }
    const requestedOccurrence = this.parseInstant(input.occurrenceStartsAt, "Meeting occurrence");
    const prepared = await this.database.transaction(async (client) => {
      const event = await this.eventForCreator(client, principal, input.eventId);
      const occurrence = await this.occurrence(client, event, requestedOccurrence);
      const requestHash = stableHash({
        callType: input.callType,
        eventId: input.eventId,
        occurrenceStartsAt: occurrence.startsAt.toISOString(),
        roleAssignments: normalizedAssignments
      });
      const existingKey = await client.query<{ request_hash: string; response_json: { meetingId?: string } | null }>(
        `select request_hash, response_json from idempotency_keys
         where scope = 'meeting.schedule' and key = $1 and owner_id = $2`,
        [input.clientMeetingId, principal.internalUserId]
      );
      if (existingKey.rowCount) {
        const row = existingKey.rows[0]!;
        if (row.request_hash !== requestHash) {
          throw new ConflictException("Idempotency key was already used with a different meeting.");
        }
        if (!row.response_json?.meetingId) {
          throw new ConflictException("The original meeting request is still being processed.");
        }
        return { meetingId: row.response_json.meetingId, replay: true };
      }

      const attendees = await this.eventAttendees(client, event.id);
      if (!attendees.length) throw new BadRequestException("A scheduled meeting needs at least one event attendee.");
      if (attendees.length + 1 > maximumMeetingParticipants) {
        throw new BadRequestException(`Scheduled meetings are limited to ${maximumMeetingParticipants} participants.`);
      }
      if (event.space_type === "hub" && attendees.length !== 1) {
        throw new BadRequestException("A private hub meeting must contain the owner and exactly one person.");
      }
      if (!["direct", "open_group", "hub", "meeting_backstage"].includes(event.space_type)) {
        throw new BadRequestException("Scheduled meetings are not available for this conversation type.");
      }

      const attendeeByPublicId = new Map(attendees.map((attendee) => [attendee.public_id, attendee]));
      const unknownAssignment = normalizedAssignments.find((item) => !attendeeByPublicId.has(item.userId));
      if (unknownAssignment) throw new ForbiddenException("Meeting roles may only be assigned to current event attendees.");
      for (const assignment of normalizedAssignments) {
        const attendee = attendeeByPublicId.get(assignment.userId)!;
        if (attendee.response_status === "declined" && assignment.role !== "attendee") {
          throw new BadRequestException("A declined attendee cannot be assigned a meeting role.");
        }
        if (["guest", "subscriber"].includes(attendee.organization_role) && assignment.role !== "attendee") {
          throw new ForbiddenException("Guest participants must remain attendees.");
        }
      }
      const alreadyScheduled = await client.query(
        `select 1 from call_sessions
         where event_id = $1 and occurrence_starts_at = $2 and session_kind = 'scheduled_meeting'`,
        [event.id, occurrence.startsAt]
      );
      if (alreadyScheduled.rowCount) throw new ConflictException("This event occurrence already has a meeting.");

      const claimed = await client.query(
        `insert into idempotency_keys (scope, key, owner_id, request_hash, expires_at)
         values ('meeting.schedule', $1, $2, $3, now() + interval '30 days')
         on conflict do nothing returning key`,
        [input.clientMeetingId, principal.internalUserId, requestHash]
      );
      if (!claimed.rowCount) throw new ConflictException("The meeting request is already being processed.");

      const meetingId = randomUUID();
      const providerRoomName = opaqueName("hht_meeting");
      const lobbyOpensAt = new Date(occurrence.startsAt.getTime() - lobbyLeadMilliseconds);
      const expiresAt = new Date(occurrence.endsAt.getTime() + lobbyTailMilliseconds);
      await client.query(
        `insert into call_sessions (
           id, organization_id, space_id, created_by, call_type, provider_room_name,
           status, expires_at, session_kind, event_id, event_version,
           occurrence_starts_at, occurrence_ends_at, lobby_opens_at
         ) values (
           $1, $2, $3, $4, $5, $6,
           'scheduled', $7, 'scheduled_meeting', $8, $9, $10, $11, $12
         )`,
        [
          meetingId,
          event.organization_id,
          event.space_id,
          principal.internalUserId,
          input.callType,
          providerRoomName,
          expiresAt,
          event.id,
          event.version,
          occurrence.startsAt,
          occurrence.endsAt,
          lobbyOpensAt
        ]
      );
      await client.query(
        `insert into call_participants (
           call_session_id, user_id, role, status, provider_identity,
           can_publish_audio, can_publish_video, event_response_status,
           admitted_at, admitted_by
         ) values ($1, $2, 'host', 'admitted', $3, true, $4, 'accepted', now(), $2)`,
        [meetingId, principal.internalUserId, opaqueName("hht_media", 18), input.callType === "video"]
      );
      const roleByPublicId = new Map(normalizedAssignments.map((item) => [item.userId, item.role]));
      for (const attendee of attendees) {
        const role = roleByPublicId.get(attendee.public_id) ?? "attendee";
        const canPublish = role !== "attendee";
        const status = attendee.response_status === "declined" ? "declined" : "invited";
        await client.query(
          `insert into call_participants (
             call_session_id, user_id, role, status, provider_identity,
             can_publish_audio, can_publish_video, event_response_status, declined_at
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, case when $4 = 'declined' then now() else null end)`,
          [
            meetingId,
            attendee.internal_user_id,
            role,
            status,
            opaqueName("hht_media", 18),
            canPublish,
            canPublish && input.callType === "video",
            attendee.response_status
          ]
        );
      }
      await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.scheduled", {
        occurrenceStartsAt: occurrence.startsAt.toISOString(),
        participantCount: attendees.length + 1
      });
      await this.audit(client, event.organization_id, principal.internalUserId, meetingId, "meeting.scheduled", {
        eventId: event.id,
        eventVersion: event.version,
        occurrenceStartsAt: occurrence.startsAt.toISOString(),
        participantCount: attendees.length + 1
      });
      await this.enqueue(client, meetingId);
      await client.query(
        `update idempotency_keys set response_json = $4::jsonb, status_code = 201
         where scope = 'meeting.schedule' and key = $1 and owner_id = $2 and request_hash = $3`,
        [input.clientMeetingId, principal.internalUserId, requestHash, JSON.stringify({ meetingId })]
      );
      return { meetingId, replay: false };
    });
    return this.get(principal, prepared.meetingId);
  }

  async get(principal: AuthPrincipal, meetingId: string): Promise<MeetingView> {
    await this.expire(meetingId);
    return this.database.transaction((client) => this.project(client, meetingId, principal.internalUserId));
  }

  async open(principal: AuthPrincipal, meetingId: string, version: number): Promise<MeetingView> {
    if (!this.livekit.capabilities().available) {
      throw new ServiceUnavailableException("Scheduled meetings require a configured LiveKit service.");
    }
    await this.expire(meetingId);
    const prepared = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      if (!this.isModerator(locked.role)) throw new ForbiddenException("Only the host or cohost may open the lobby.");
      if (terminalMeetingStatuses.has(locked.status)) throw new ConflictException("This meeting has ended.");
      if (["lobby_open", "active"].includes(locked.status)) {
        return { alreadyOpen: true, participantCount: 0, roomName: locked.provider_room_name };
      }
      if (!['scheduled', 'starting'].includes(locked.status)) throw new ConflictException("The lobby cannot be opened now.");
      if (locked.status === "scheduled" && locked.version !== version) {
        throw new ConflictException("This meeting changed in another window. Refresh before opening it.");
      }
      const now = Date.now();
      if (now < locked.lobby_opens_at.getTime()) throw new ConflictException("The lobby is not open yet.");
      if (now >= locked.expires_at.getTime()) throw new ConflictException("The meeting lobby has expired.");
      if (locked.status === "scheduled") {
        await client.query(
          `update call_sessions set status = 'starting', version = version + 1, updated_at = now()
           where id = $1 and session_kind = 'scheduled_meeting' and status = 'scheduled' and version = $2`,
          [meetingId, version]
        );
        await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.open_requested");
        await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, "meeting.open_requested");
      }
      const count = await client.query<{ count: number }>(
        "select count(*)::int as count from call_participants where call_session_id = $1 and status <> 'declined'",
        [meetingId]
      );
      return {
        alreadyOpen: false,
        participantCount: count.rows[0]?.count ?? 1,
        roomName: locked.provider_room_name
      };
    });
    if (!prepared.alreadyOpen) {
      try {
        await this.livekit.ensureRoom(prepared.roomName, prepared.participantCount);
      } catch {
        await this.failOpen(meetingId, principal.internalUserId);
        throw new ServiceUnavailableException("The meeting service could not open the media room. Try again.");
      }
      await this.database.transaction(async (client) => {
        const updated = await client.query<{ organization_id: string }>(
          `update call_sessions
           set status = 'lobby_open', lobby_opened_at = coalesce(lobby_opened_at, now()),
               version = version + 1, updated_at = now()
           where id = $1 and session_kind = 'scheduled_meeting' and status = 'starting'
           returning organization_id`,
          [meetingId]
        );
        if (!updated.rowCount) return;
        await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.lobby_opened");
        await this.audit(client, updated.rows[0]!.organization_id, principal.internalUserId, meetingId, "meeting.lobby_opened");
        await this.enqueue(client, meetingId);
      });
    }
    return this.get(principal, meetingId);
  }

  enter(principal: AuthPrincipal, meetingId: string): Promise<MeetingView> {
    return this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      this.assertOpen(locked.status);
      if (["declined", "left", "removed", "missed"].includes(locked.participant_status)) {
        throw new ConflictException("This meeting invitation is no longer enterable.");
      }
      if (locked.event_response_status === "declined") {
        throw new ConflictException("A declined event invitation cannot enter the meeting.");
      }
      if (locked.participant_status === "invited") {
        const autoAdmit = this.isModerator(locked.role);
        await client.query(
          `update call_participants set
             status = $3,
             waiting_at = case when $3 = 'waiting' then now() else waiting_at end,
             admitted_at = case when $3 = 'admitted' then now() else admitted_at end,
             admitted_by = case when $3 = 'admitted' then $2 else admitted_by end,
             updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [meetingId, principal.internalUserId, autoAdmit ? "admitted" : "waiting"]
        );
        const action = autoAdmit ? "meeting.participant_admitted" : "meeting.participant_waiting";
        await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, action);
        await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, action);
        await this.enqueue(client, meetingId);
      }
      return this.project(client, meetingId, principal.internalUserId);
    });
  }

  moderate(
    principal: AuthPrincipal,
    meetingId: string,
    targetPublicId: string,
    action: "admit" | "deny"
  ): Promise<MeetingView> {
    return this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      this.assertOpen(locked.status);
      if (!this.isModerator(locked.role)) throw new ForbiddenException("Only the host or cohost may manage the waiting room.");
      const target = await client.query<{ role: MeetingRole; status: MeetingParticipantStatus; user_id: string }>(
        `select cp.user_id, cp.role, cp.status from call_participants cp
         join users u on u.id = cp.user_id
         where cp.call_session_id = $1 and u.public_id = $2 for update of cp`,
        [meetingId, targetPublicId]
      );
      const participant = target.rows[0];
      if (!participant) throw new NotFoundException("Meeting participant was not found.");
      if (participant.role === "host") throw new ForbiddenException("The host cannot be moderated.");
      if (participant.status !== "waiting") throw new ConflictException("Only a waiting participant can be admitted or denied.");
      if (action === "admit") {
        await client.query(
          `update call_participants
           set status = 'admitted', admitted_at = now(), admitted_by = $3, updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [meetingId, participant.user_id, principal.internalUserId]
        );
      } else {
        await client.query(
          `update call_participants
           set status = 'removed', left_at = now(), token_version = token_version + 1, updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [meetingId, participant.user_id]
        );
      }
      const eventType = `meeting.participant_${action === "admit" ? "admitted" : "denied"}`;
      await this.event(client, meetingId, principal.internalUserId, participant.user_id, eventType);
      await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, eventType, {
        targetUserId: targetPublicId
      });
      await this.enqueue(client, meetingId);
      return this.project(client, meetingId, principal.internalUserId);
    });
  }

  async changeRole(
    principal: AuthPrincipal,
    meetingId: string,
    targetPublicId: string,
    role: Exclude<MeetingRole, "host">,
    version: number
  ): Promise<MeetingView> {
    const changed = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      if (locked.role !== "host" || locked.created_by !== principal.internalUserId) {
        throw new ForbiddenException("Only the meeting host may change participant roles.");
      }
      if (terminalMeetingStatuses.has(locked.status)) throw new ConflictException("This meeting has ended.");
      if (locked.version !== version) throw new ConflictException("This meeting changed in another window. Refresh before changing roles.");
      const target = await client.query<{
        organization_role: string;
        participant_status: MeetingParticipantStatus;
        previous_role: MeetingRole;
        provider_identity: string;
        screen_share_status: ScreenShareStatus;
        user_id: string;
      }>(
        `select cp.user_id, cp.role as previous_role, cp.status as participant_status,
                cp.provider_identity, cp.screen_share_status, om.role as organization_role
         from call_participants cp
         join users u on u.id = cp.user_id
         join call_sessions c on c.id = cp.call_session_id
         join organization_memberships om
           on om.organization_id = c.organization_id and om.user_id = cp.user_id and om.status = 'active'
         where cp.call_session_id = $1 and u.public_id = $2 for update of cp`,
        [meetingId, targetPublicId]
      );
      const participant = target.rows[0];
      if (!participant) throw new NotFoundException("Meeting participant was not found.");
      if (participant.previous_role === "host") throw new ForbiddenException("The host role cannot be reassigned.");
      if (participant.participant_status === "declined") throw new ConflictException("A declined attendee cannot receive a meeting role.");
      if (participant.participant_status === "connecting") {
        throw new ConflictException("Wait for the participant connection to finish before changing the role.");
      }
      if (["guest", "subscriber"].includes(participant.organization_role) && role !== "attendee") {
        throw new ForbiddenException("Guest participants must remain attendees.");
      }
      if (participant.previous_role === role) {
        return {
          changed: false,
          joined: false,
          keepScreenShare: participant.screen_share_status !== "off",
          providerIdentity: participant.provider_identity,
          roomName: locked.provider_room_name
        };
      }
      const canPublish = role !== "attendee";
      await client.query(
        `update call_participants set
           role = $3, can_publish_audio = $4, can_publish_video = $5,
           screen_share_status = case when $4 then screen_share_status else 'off' end,
           screen_share_ended_at = case
             when not $4 and screen_share_status <> 'off' then now()
             else screen_share_ended_at end,
           token_version = token_version + 1, role_updated_at = now(), updated_at = now()
         where call_session_id = $1 and user_id = $2`,
        [meetingId, participant.user_id, role, canPublish, canPublish && locked.call_type === "video"]
      );
      await client.query(
        "update call_sessions set version = version + 1, updated_at = now() where id = $1 and version = $2",
        [meetingId, version]
      );
      await this.event(client, meetingId, principal.internalUserId, participant.user_id, "meeting.role_changed", {
        from: participant.previous_role,
        to: role
      });
      await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, "meeting.role_changed", {
        from: participant.previous_role,
        targetUserId: targetPublicId,
        to: role
      });
      if (!canPublish && participant.screen_share_status !== "off") {
        await this.event(client, meetingId, principal.internalUserId, participant.user_id, "meeting.screen_share_stopped", {
          reason: "permission_changed"
        });
        await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, "meeting.screen_share_stopped", {
          reason: "permission_changed",
          targetUserId: targetPublicId
        });
      }
      return {
        changed: true,
        joined: participant.participant_status === "joined",
        keepScreenShare: canPublish && participant.screen_share_status !== "off",
        providerIdentity: participant.provider_identity,
        roomName: locked.provider_room_name
      };
    });
    if (changed.changed && changed.joined) {
      try {
        await this.livekit.updateParticipantPermissions(
          changed.roomName,
          changed.providerIdentity,
          role !== "attendee",
          role !== "attendee" && (await this.meetingType(meetingId)) === "video",
          changed.keepScreenShare
        );
      } catch {
        await this.livekit.removeParticipant(changed.roomName, changed.providerIdentity).catch(() => undefined);
        await this.database.transaction(async (client) => {
          await client.query(
            `update call_participants
             set status = 'removed', left_at = now(), screen_share_status = 'off',
                 screen_share_ended_at = case when screen_share_status <> 'off' then now() else screen_share_ended_at end,
                 token_version = token_version + 1, updated_at = now()
             where call_session_id = $1 and provider_identity = $2`,
            [meetingId, changed.providerIdentity]
          );
          await this.event(client, meetingId, principal.internalUserId, null, "meeting.role_provider_sync_failed");
          await this.audit(client, principal.state.user.organizationId, principal.internalUserId, meetingId, "meeting.role_provider_sync_failed");
          await this.enqueue(client, meetingId);
        });
        throw new ServiceUnavailableException("The participant role could not be synchronized with the meeting provider.");
      }
    }
    await this.database.transaction((client) => this.enqueue(client, meetingId));
    return this.get(principal, meetingId);
  }

  async join(principal: AuthPrincipal, meetingId: string): Promise<MeetingJoinView> {
    if (!this.livekit.capabilities().available) {
      throw new ServiceUnavailableException("Scheduled meetings require a configured LiveKit service.");
    }
    await this.expire(meetingId);
    const prepared = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      this.assertOpen(locked.status);
      await this.recordings.assertJoinAllowed(client, meetingId, principal.internalUserId);
      if (!["admitted", "connecting", "joined"].includes(locked.participant_status)) {
        throw new ConflictException("Wait for admission before joining the meeting.");
      }
      if (locked.participant_status === "admitted") {
        await client.query(
          `update call_participants set status = 'connecting', connecting_at = now(), updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [meetingId, principal.internalUserId]
        );
        await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.participant_connecting");
        await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, "meeting.participant_connecting");
        await this.enqueue(client, meetingId);
      }
      return {
        displayName: principal.state.user.displayName,
        locked,
        meeting: await this.project(client, meetingId, principal.internalUserId)
      };
    });
    const credential = await this.livekit.joinCredential({
      callId: meetingId,
      callType: prepared.locked.call_type,
      canPublishAudio: prepared.locked.can_publish_audio,
      canPublishVideo: prepared.locked.can_publish_video,
      displayName: prepared.displayName,
      identity: prepared.locked.provider_identity,
      roomName: prepared.locked.provider_room_name
    });
    return {
      meeting: prepared.meeting,
      serverUrl: credential.serverUrl,
      token: credential.token,
      tokenExpiresAt: credential.expiresAt.toISOString()
    };
  }

  connected(principal: AuthPrincipal, meetingId: string): Promise<MeetingView> {
    return this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      this.assertOpen(locked.status);
      await this.recordings.assertJoinAllowed(client, meetingId, principal.internalUserId);
      if (!["connecting", "joined"].includes(locked.participant_status)) {
        throw new ConflictException("A join credential is required before confirming the media connection.");
      }
      if (locked.participant_status !== "joined") {
        await client.query(
          `update call_participants
           set status = 'joined', joined_at = coalesce(joined_at, now()), left_at = null, updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [meetingId, principal.internalUserId]
        );
        await client.query(
          `update call_sessions
           set status = 'active', started_at = coalesce(started_at, now()), version = version + 1, updated_at = now()
           where id = $1 and session_kind = 'scheduled_meeting' and status in ('lobby_open', 'active')`,
          [meetingId]
        );
        await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.participant_joined");
        await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, "meeting.participant_joined");
        await this.enqueue(client, meetingId);
      }
      return this.project(client, meetingId, principal.internalUserId);
    });
  }

  async startScreenShare(principal: AuthPrincipal, meetingId: string): Promise<MeetingView> {
    const prepared = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      if (locked.status !== "active" || locked.participant_status !== "joined") {
        throw new ConflictException("Join the active meeting before sharing a screen.");
      }
      if (!["host", "cohost", "speaker"].includes(locked.role)) {
        throw new ForbiddenException("Only the host, cohost, or speaker may share a screen.");
      }
      if (locked.screen_share_status !== "off") return { changed: false, locked };
      const current = await client.query<{ user_id: string }>(
        `select user_id from call_participants
         where call_session_id = $1 and screen_share_status in ('starting', 'active')
         limit 1`,
        [meetingId]
      );
      if (current.rowCount) throw new ConflictException("Another participant is already sharing a screen.");
      await client.query(
        `update call_participants
         set screen_share_status = 'starting', screen_share_requested_at = now(),
             screen_share_started_at = null, screen_share_ended_at = null, updated_at = now()
         where call_session_id = $1 and user_id = $2`,
        [meetingId, principal.internalUserId]
      );
      await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.screen_share_requested");
      await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, "meeting.screen_share_requested");
      await this.enqueue(client, meetingId);
      return { changed: true, locked };
    });
    if (!prepared.changed) return this.get(principal, meetingId);

    try {
      await this.livekit.updateParticipantPermissions(
        prepared.locked.provider_room_name,
        prepared.locked.provider_identity,
        prepared.locked.can_publish_audio,
        prepared.locked.can_publish_video,
        true
      );
    } catch {
      await this.database.transaction(async (client) => {
        await client.query(
          `update call_participants
           set screen_share_status = 'off', screen_share_ended_at = now(), updated_at = now()
           where call_session_id = $1 and user_id = $2 and screen_share_status = 'starting'`,
          [meetingId, principal.internalUserId]
        );
        await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.screen_share_provider_grant_failed");
        await this.audit(client, prepared.locked.organization_id, principal.internalUserId, meetingId, "meeting.screen_share_provider_grant_failed");
        await this.enqueue(client, meetingId);
      });
      throw new ServiceUnavailableException("Screen sharing permission could not be granted. Try again.");
    }
    return this.get(principal, meetingId);
  }

  async confirmScreenShare(principal: AuthPrincipal, meetingId: string): Promise<MeetingView> {
    return this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      if (locked.status !== "active" || locked.participant_status !== "joined") {
        throw new ConflictException("The participant is no longer connected to this meeting.");
      }
      if (!["host", "cohost", "speaker"].includes(locked.role)) {
        throw new ForbiddenException("This meeting role cannot publish a shared screen.");
      }
      if (locked.screen_share_status === "off") {
        throw new ConflictException("Request screen sharing permission before publishing a screen.");
      }
      if (locked.screen_share_status === "starting") {
        await client.query(
          `update call_participants
           set screen_share_status = 'active', screen_share_started_at = coalesce(screen_share_started_at, now()),
               updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [meetingId, principal.internalUserId]
        );
        await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.screen_share_started");
        await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, "meeting.screen_share_started");
        await this.enqueue(client, meetingId);
      }
      return this.project(client, meetingId, principal.internalUserId);
    });
  }

  async stopScreenShare(
    principal: AuthPrincipal,
    meetingId: string,
    reason: ScreenShareStopReason
  ): Promise<MeetingView> {
    const prepared = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      if (locked.screen_share_status === "off") return { changed: false, locked };
      await client.query(
        `update call_participants
         set screen_share_status = 'off', screen_share_ended_at = now(), updated_at = now()
         where call_session_id = $1 and user_id = $2`,
        [meetingId, principal.internalUserId]
      );
      await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.screen_share_stopped", { reason });
      await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, "meeting.screen_share_stopped", { reason });
      await this.enqueue(client, meetingId);
      return { changed: true, locked };
    });
    if (!prepared.changed) return this.get(principal, meetingId);

    try {
      await this.livekit.updateParticipantPermissions(
        prepared.locked.provider_room_name,
        prepared.locked.provider_identity,
        prepared.locked.can_publish_audio,
        prepared.locked.can_publish_video,
        false
      );
    } catch {
      await this.livekit.removeParticipant(
        prepared.locked.provider_room_name,
        prepared.locked.provider_identity
      ).catch(() => undefined);
      await this.database.transaction(async (client) => {
        await client.query(
          `update call_participants
           set status = 'removed', left_at = now(), screen_share_status = 'off',
               screen_share_ended_at = coalesce(screen_share_ended_at, now()),
               token_version = token_version + 1, updated_at = now()
           where call_session_id = $1 and user_id = $2 and status in ('connecting', 'joined')`,
          [meetingId, principal.internalUserId]
        );
        await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.screen_share_provider_revoke_failed");
        await this.audit(client, prepared.locked.organization_id, principal.internalUserId, meetingId, "meeting.screen_share_provider_revoke_failed");
        await this.enqueue(client, meetingId);
      });
      throw new ServiceUnavailableException("Screen sharing was stopped locally, but the media permission could not be synchronized. The participant was disconnected.");
    }
    return this.get(principal, meetingId);
  }

  async leave(principal: AuthPrincipal, meetingId: string): Promise<MeetingView> {
    await this.expire(meetingId);
    const result = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      if (terminalMeetingStatuses.has(locked.status)) {
        return { remove: false, roomName: locked.provider_room_name, identity: locked.provider_identity };
      }
      if (!["waiting", "admitted", "connecting", "joined"].includes(locked.participant_status)) {
        throw new ConflictException("This participant is not in the meeting lobby.");
      }
      await client.query(
        `update call_participants
         set status = 'left', left_at = now(), screen_share_status = 'off',
             screen_share_ended_at = case when screen_share_status <> 'off' then now() else screen_share_ended_at end,
             token_version = token_version + 1, updated_at = now()
         where call_session_id = $1 and user_id = $2`,
        [meetingId, principal.internalUserId]
      );
      await this.event(client, meetingId, principal.internalUserId, principal.internalUserId, "meeting.participant_left");
      await this.audit(client, locked.organization_id, principal.internalUserId, meetingId, "meeting.participant_left");
      await this.enqueue(client, meetingId);
      return {
        remove: ["connecting", "joined"].includes(locked.participant_status),
        roomName: locked.provider_room_name,
        identity: locked.provider_identity
      };
    });
    if (result.remove) await this.livekit.removeParticipant(result.roomName, result.identity).catch(() => undefined);
    return this.get(principal, meetingId);
  }

  async end(principal: AuthPrincipal, meetingId: string, version: number): Promise<MeetingView> {
    const result = await this.database.transaction(async (client) => {
      const locked = await this.lockParticipant(client, principal, meetingId);
      if (locked.role !== "host" || locked.created_by !== principal.internalUserId) {
        throw new ForbiddenException("Only the meeting host may end the meeting.");
      }
      if (!terminalMeetingStatuses.has(locked.status)) {
        if (locked.version !== version) throw new ConflictException("This meeting changed in another window. Refresh before ending it.");
        const status = locked.status === "scheduled" ? "cancelled" : "ended";
        await this.terminate(client, meetingId, principal.internalUserId, locked.organization_id, status, "host_ended");
      }
      return {
        deleteRoom: locked.status !== "scheduled",
        roomName: locked.provider_room_name,
        view: await this.project(client, meetingId, principal.internalUserId)
      };
    });
    await this.recordings.stopForSession(meetingId, principal.internalUserId);
    if (result.deleteRoom) await this.deleteProviderRoom(result.roomName, meetingId);
    return this.get(principal, meetingId);
  }

  private async eventForCreator(client: PoolClient, principal: AuthPrincipal, eventId: string) {
    const result = await client.query<EventRow>(
      `select e.id, e.organization_id, e.space_id, e.created_by, e.title, e.status, e.version,
              e.timezone, e.all_day, e.recurrence_json,
              to_char(e.starts_local, 'YYYY-MM-DD"T"HH24:MI:SS') as starts_local_text,
              to_char(e.ends_local, 'YYYY-MM-DD"T"HH24:MI:SS') as ends_local_text,
              s.type as space_type, s.owner_id as space_owner_id
       from events e join conversation_spaces s on s.id = e.space_id
       where e.id = $1 and e.organization_id = $2 and e.created_by = $3`,
      [eventId, principal.state.user.organizationId, principal.internalUserId]
    );
    const event = result.rows[0];
    if (!event) throw new NotFoundException("A shared event owned by this user was not found.");
    if (event.status !== "scheduled") throw new ConflictException("Cancelled events cannot schedule meetings.");
    if (event.all_day) throw new BadRequestException("All-day events cannot host a timed meeting lobby.");
    return event;
  }

  private async eventAttendees(client: PoolClient, eventId: string) {
    const result = await client.query<EventAttendeeRow>(
      `select ea.user_id as internal_user_id, ea.response_status,
              u.public_id, u.display_name, om.role as organization_role,
              p.public_profile_json ->> 'characterId' as character_id
       from event_attendees ea
       join users u on u.id = ea.user_id and u.status = 'active'
       join events e on e.id = ea.event_id
       join organization_memberships om
         on om.organization_id = e.organization_id and om.user_id = ea.user_id and om.status = 'active'
       left join profiles p on p.user_id = u.id
       where ea.event_id = $1 and ea.revoked_at is null
       order by ea.invited_at, ea.user_id`,
      [eventId]
    );
    return result.rows;
  }

  private async occurrence(client: PoolClient, event: EventRow, requested: Date) {
    const recurrence = parseStoredRecurrence(event.recurrence_json);
    const localStarts = recurrenceLocalStarts(event.starts_local_text, recurrence);
    const localResult = await client.query<{ local_text: string }>(
      `select to_char($1::timestamptz at time zone $2, 'YYYY-MM-DD"T"HH24:MI:SS') as local_text`,
      [requested, event.timezone]
    );
    const localText = localResult.rows[0]?.local_text;
    if (!localText || !localStarts.includes(localText)) {
      throw new BadRequestException("The requested meeting time is not an occurrence of this event.");
    }
    const durationSeconds = Math.round(
      (localDateTimeToPseudoUtc(event.ends_local_text).getTime()
        - localDateTimeToPseudoUtc(event.starts_local_text).getTime()) / 1_000
    );
    const instant = await client.query<{ ends_at: Date; starts_at: Date; valid: boolean }>(
      `select
         $1::timestamp at time zone $2 as starts_at,
         ($1::timestamp + make_interval(secs => $3)) at time zone $2 as ends_at,
         (($1::timestamp at time zone $2) at time zone $2) = $1::timestamp as valid`,
      [localText, event.timezone, durationSeconds]
    );
    const row = instant.rows[0];
    if (!row?.valid || row.starts_at.getTime() !== requested.getTime()) {
      throw new BadRequestException("The meeting occurrence does not match the event timezone.");
    }
    if (row.ends_at.getTime() + lobbyTailMilliseconds <= Date.now()) {
      throw new ConflictException("This meeting occurrence has already expired.");
    }
    return { endsAt: row.ends_at, startsAt: row.starts_at };
  }

  private parseInstant(raw: string, fieldName: string) {
    if (!instantPattern.test(raw)) throw new BadRequestException(`${fieldName} must be a UTC ISO timestamp.`);
    const value = new Date(raw);
    if (Number.isNaN(value.getTime())) throw new BadRequestException(`${fieldName} is invalid.`);
    return value;
  }

  private async lockParticipant(client: PoolClient, principal: AuthPrincipal, meetingId: string) {
    const result = await client.query<LockedMeetingParticipant>(
      `select c.organization_id, c.created_by, c.call_type, c.provider_room_name,
              c.status, c.version, c.expires_at, c.lobby_opens_at, c.occurrence_ends_at,
              cp.role, cp.status as participant_status, cp.event_response_status,
              cp.provider_identity, cp.can_publish_audio, cp.can_publish_video,
              cp.screen_share_status
       from call_sessions c
       join call_participants cp on cp.call_session_id = c.id and cp.user_id = $2
       where c.id = $1 and c.organization_id = $3 and c.session_kind = 'scheduled_meeting'
       for update of c, cp`,
      [meetingId, principal.internalUserId, principal.state.user.organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Scheduled meeting was not found.");
    return row;
  }

  private async project(client: PoolClient, meetingId: string, viewerInternalId: string): Promise<MeetingView> {
    const meetingResult = await client.query<MeetingRow>(
      `select c.id, c.organization_id, c.space_id, c.created_by, c.call_type,
              c.provider_room_name, c.status, c.version, c.expires_at,
              c.event_id, c.occurrence_starts_at, c.occurrence_ends_at,
              c.lobby_opens_at, c.lobby_opened_at, c.started_at, c.ended_at,
              c.end_reason, c.created_at, e.title,
              s.type as space_type, s.owner_id as space_owner_id
       from call_sessions c
       join events e on e.id = c.event_id
       join conversation_spaces s on s.id = c.space_id
       where c.id = $1 and c.session_kind = 'scheduled_meeting'`,
      [meetingId]
    );
    const meeting = meetingResult.rows[0];
    if (!meeting) throw new NotFoundException("Scheduled meeting was not found.");
    const participantResult = await client.query<MeetingParticipantRow>(
      `select cp.user_id, cp.role, cp.status, cp.provider_identity,
              cp.can_publish_audio, cp.can_publish_video, cp.screen_share_status,
              cp.screen_share_started_at, cp.event_response_status,
              cp.invited_at, cp.waiting_at, cp.admitted_at, cp.joined_at, cp.left_at,
              u.public_id, u.display_name,
              p.public_profile_json ->> 'characterId' as character_id
       from call_participants cp
       join users u on u.id = cp.user_id
       left join profiles p on p.user_id = u.id
       where cp.call_session_id = $1
       order by case cp.role when 'host' then 0 when 'cohost' then 1 when 'speaker' then 2 else 3 end,
                cp.invited_at, cp.user_id`,
      [meetingId]
    );
    const viewer = participantResult.rows.find((row) => row.user_id === viewerInternalId);
    if (!viewer) throw new NotFoundException("Scheduled meeting was not found.");
    const terminal = terminalMeetingStatuses.has(meeting.status);
    const open = ["lobby_open", "active"].includes(meeting.status);
    const moderator = this.isModerator(viewer.role);
    const now = Date.now();
    const recording = await this.recordings.project(client, meetingId, viewerInternalId);
    return {
      callType: meeting.call_type,
      canAdmit: !terminal && open && moderator,
      canEnd: !terminal && viewer.role === "host" && meeting.created_by === viewerInternalId,
      canEnter: !terminal && open && viewer.status === "invited" && viewer.event_response_status !== "declined",
      canJoin: !terminal && open && ["admitted", "connecting", "joined"].includes(viewer.status),
      canLeave: !terminal && ["waiting", "admitted", "connecting", "joined"].includes(viewer.status),
      canManageRoles: !terminal && viewer.role === "host" && meeting.created_by === viewerInternalId,
      canShareScreen: !terminal
        && meeting.status === "active"
        && viewer.status === "joined"
        && ["host", "cohost", "speaker"].includes(viewer.role),
      canRequestRecording: this.recordings.canRequest(meeting.status, viewer.status, viewer.role, recording),
      canOpen: !terminal
        && ["scheduled", "starting"].includes(meeting.status)
        && moderator
        && now >= meeting.lobby_opens_at.getTime()
        && now < meeting.expires_at.getTime(),
      createdAt: meeting.created_at.toISOString(),
      ...(meeting.ended_at ? { endedAt: meeting.ended_at.toISOString() } : {}),
      ...(meeting.end_reason ? { endReason: meeting.end_reason } : {}),
      eventId: meeting.event_id,
      id: meeting.id,
      isCreator: meeting.created_by === viewerInternalId,
      lobbyClosesAt: meeting.expires_at.toISOString(),
      ...(meeting.lobby_opened_at ? { openedAt: meeting.lobby_opened_at.toISOString() } : {}),
      lobbyOpensAt: meeting.lobby_opens_at.toISOString(),
      myRole: viewer.role,
      myStatus: viewer.status,
      ...(recording ? { recording } : {}),
      occurrenceEndsAt: meeting.occurrence_ends_at.toISOString(),
      occurrenceStartsAt: meeting.occurrence_starts_at.toISOString(),
      participants: participantResult.rows.map((participant) => ({
        ...(participant.admitted_at ? { admittedAt: participant.admitted_at.toISOString() } : {}),
        canPublishAudio: participant.can_publish_audio,
        canPublishVideo: participant.can_publish_video,
        eventResponse: participant.event_response_status,
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
        ...(participant.screen_share_started_at ? { screenShareStartedAt: participant.screen_share_started_at.toISOString() } : {}),
        screenShareStatus: participant.screen_share_status,
        status: participant.status,
        ...(participant.waiting_at ? { waitingAt: participant.waiting_at.toISOString() } : {})
      })),
      spaceId: meeting.space_id,
      ...(meeting.started_at ? { startedAt: meeting.started_at.toISOString() } : {}),
      status: meeting.status,
      title: meeting.title,
      version: meeting.version,
      ...(moderator
        ? { waitingCount: participantResult.rows.filter((participant) => participant.status === "waiting").length }
        : {})
    };
  }

  private assertOpen(status: MeetingStatus) {
    if (!["lobby_open", "active"].includes(status)) throw new ConflictException("The meeting lobby is not open.");
  }

  private isModerator(role: MeetingRole) {
    return role === "host" || role === "cohost";
  }

  private meetingType(meetingId: string) {
    return this.database.query<{ call_type: CallType }>(
      "select call_type from call_sessions where id = $1 and session_kind = 'scheduled_meeting'",
      [meetingId]
    ).then((result) => result.rows[0]?.call_type ?? "voice");
  }

  private async failOpen(meetingId: string, actorId: string) {
    await this.database.transaction(async (client) => {
      const updated = await client.query<{ organization_id: string }>(
        `update call_sessions
         set status = 'failed', ended_at = now(), end_reason = 'provider_unavailable',
             version = version + 1, updated_at = now()
         where id = $1 and session_kind = 'scheduled_meeting' and status = 'starting'
         returning organization_id`,
        [meetingId]
      );
      if (!updated.rowCount) return;
      await client.query(
        `update call_participants set
           status = case when status = 'declined' then status else 'missed' end,
           left_at = case when status in ('waiting', 'admitted', 'connecting', 'joined') then now() else left_at end,
           screen_share_status = 'off',
           screen_share_ended_at = case when screen_share_status <> 'off' then now() else screen_share_ended_at end,
           token_version = token_version + 1, updated_at = now()
         where call_session_id = $1`,
        [meetingId]
      );
      await this.event(client, meetingId, actorId, actorId, "meeting.provider_start_failed", { provider: "livekit" });
      await this.audit(client, updated.rows[0]!.organization_id, actorId, meetingId, "meeting.provider_start_failed", {
        provider: "livekit"
      });
      await this.enqueue(client, meetingId);
    });
  }

  private async expire(meetingId: string) {
    const result = await this.database.transaction(async (client) => {
      const meeting = await client.query<{
        lobby_opened_at: Date | null;
        organization_id: string;
        provider_room_name: string;
        status: MeetingStatus;
      }>(
        `select organization_id, provider_room_name, status, lobby_opened_at
         from call_sessions
         where id = $1 and session_kind = 'scheduled_meeting' for update`,
        [meetingId]
      );
      const row = meeting.rows[0];
      if (!row || terminalMeetingStatuses.has(row.status)) return undefined;
      const updated = await client.query(
        `update call_sessions
         set status = 'expired', ended_at = now(), end_reason = 'lobby_expired',
             version = version + 1, updated_at = now()
         where id = $1 and expires_at <= now()`,
        [meetingId]
      );
      if (!updated.rowCount) return undefined;
      await client.query(
        `update call_participants set
           status = case
             when status = 'declined' then status
             when status = 'invited' then 'missed'
             when status = 'joined' then 'left'
             when status in ('waiting', 'admitted', 'connecting') then 'removed'
             else status end,
           left_at = case when status in ('waiting', 'admitted', 'connecting', 'joined') then now() else left_at end,
           screen_share_status = 'off',
           screen_share_ended_at = case when screen_share_status <> 'off' then now() else screen_share_ended_at end,
           token_version = token_version + 1, updated_at = now()
         where call_session_id = $1`,
        [meetingId]
      );
      await this.event(client, meetingId, null, null, "meeting.expired");
      await this.audit(client, row.organization_id, null, meetingId, "meeting.expired");
      await this.enqueue(client, meetingId);
      return row.lobby_opened_at ? row.provider_room_name : undefined;
    });
    if (result) {
      await this.recordings.stopForSession(meetingId, null);
      await this.deleteProviderRoom(result, meetingId);
    }
  }

  private async terminate(
    client: PoolClient,
    meetingId: string,
    actorId: string,
    organizationId: string,
    status: "ended" | "cancelled",
    reason: string
  ) {
    await this.recordings.markSessionTerminated(client, meetingId, actorId, "scheduled_meeting");
    await client.query(
      `update call_sessions
       set status = $2, ended_at = now(), end_reason = $3, version = version + 1, updated_at = now()
       where id = $1 and session_kind = 'scheduled_meeting'
         and status not in ('ended', 'cancelled', 'failed', 'expired')`,
      [meetingId, status, reason]
    );
    await client.query(
      `update call_participants set
         status = case
           when status = 'declined' then status
           when status = 'invited' then 'missed'
           when status = 'joined' then 'left'
           when status in ('waiting', 'admitted', 'connecting') then 'removed'
           else status end,
         left_at = case when status in ('waiting', 'admitted', 'connecting', 'joined') then now() else left_at end,
         screen_share_status = 'off',
         screen_share_ended_at = case when screen_share_status <> 'off' then now() else screen_share_ended_at end,
         token_version = token_version + 1, updated_at = now()
       where call_session_id = $1`,
      [meetingId]
    );
    await this.event(client, meetingId, actorId, actorId, `meeting.${status}`, { reason });
    await this.audit(client, organizationId, actorId, meetingId, `meeting.${status}`, { reason });
    await this.enqueue(client, meetingId);
  }

  private async deleteProviderRoom(roomName: string, meetingId: string) {
    try {
      await this.livekit.deleteRoom(roomName);
    } catch {
      await this.database.query(
        `insert into call_events (call_session_id, event_type, metadata_json)
         values ($1, 'meeting.provider_delete_failed', '{"provider":"livekit"}'::jsonb)`,
        [meetingId]
      ).catch(() => undefined);
    }
  }

  private async enqueue(client: PoolClient, meetingId: string) {
    const recipients = await client.query<{ user_id: string }>(
      "select user_id from call_participants where call_session_id = $1 order by user_id",
      [meetingId]
    );
    for (const recipient of recipients.rows) {
      const projection = await this.project(client, meetingId, recipient.user_id);
      await client.query(
        `insert into outbox_events (aggregate_type, aggregate_id, event_type, payload_json)
         values ('meeting', $1, 'meeting.session.updated', $2::jsonb)`,
        [meetingId, JSON.stringify({
          recipientInternalId: recipient.user_id,
          realtimeEvent: "meeting:updated",
          realtimePayload: projection
        })]
      );
    }
  }

  private event(
    client: PoolClient,
    meetingId: string,
    actorId: string | null,
    participantId: string | null,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ) {
    return client.query(
      `insert into call_events (call_session_id, actor_id, participant_id, event_type, metadata_json)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [meetingId, actorId, participantId, eventType, JSON.stringify(metadata)]
    );
  }

  private audit(
    client: PoolClient,
    organizationId: string,
    actorId: string | null,
    meetingId: string,
    action: string,
    metadata: Record<string, unknown> = {}
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, 'call_session', $4, $5::jsonb)`,
      [organizationId, actorId, action, meetingId, JSON.stringify(metadata)]
    );
  }
}
