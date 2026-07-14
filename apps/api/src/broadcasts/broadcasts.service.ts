import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  findCharacterPreset,
  type BroadcastChannelSummary,
  type BroadcastDashboard,
  type BroadcastJoinView,
  type BroadcastMessageKind,
  type BroadcastMessageStatus,
  type BroadcastMessageView,
  type BroadcastModerationAction,
  type BroadcastNotificationLevel,
  type BroadcastParticipantStatus,
  type BroadcastParticipantView,
  type BroadcastPrivateHandoffView,
  type BroadcastReaction,
  type BroadcastReactionCount,
  type BroadcastReplayStatus,
  type BroadcastRole,
  type BroadcastSessionSummary,
  type BroadcastSessionView,
  type BroadcastStatus,
  type BroadcastSubscriptionStatus,
  type CallCapabilities,
  type CallType,
  type ChangeBroadcastRoleInput,
  type CreateBroadcastChannelInput,
  type CreateBroadcastMessageInput,
  type ModerateBroadcastMessageInput,
  type ScheduleBroadcastInput,
  type SendBroadcastReactionInput
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { LiveKitProviderService } from "../calls/livekit-provider.service.js";
import { DatabaseService } from "../database/database.service.js";

type ChannelRow = {
  created_at: Date;
  description: string;
  handle: string;
  id: string;
  name: string;
  notification_level: BroadcastNotificationLevel | null;
  organization_id: string;
  owner_character_id: string | null;
  owner_display_name: string;
  owner_id: string;
  owner_public_id: string;
  space_id: string;
  subscriber_count: string;
  subscription_status: BroadcastSubscriptionStatus | null;
  updated_at: Date;
  visibility: "organization" | "unlisted";
};

type SessionRow = {
  call_status: string;
  call_type: CallType;
  channel_id: string;
  chat_mode: "disabled" | "subscribers" | "moderated";
  created_at: Date;
  created_by: string;
  description: string;
  ended_at: Date | null;
  end_reason: string | null;
  expected_end_at: Date;
  id: string;
  organization_id: string;
  provider_room_name: string;
  replay_requested: boolean;
  replay_status: BroadcastReplayStatus;
  scheduled_for: Date;
  space_id: string;
  started_at: Date | null;
  status: BroadcastStatus;
  title: string;
  version: number;
  viewer_limit: number;
};

type ParticipantRow = {
  can_publish_audio: boolean;
  can_publish_video: boolean;
  character_id: string | null;
  display_name: string;
  joined_at: Date | null;
  left_at: Date | null;
  provider_identity: string;
  public_id: string;
  role: BroadcastRole;
  status: string;
  user_id: string;
};

type MessageRow = {
  anonymous_to_viewers: boolean;
  body: string;
  character_id: string | null;
  created_at: Date;
  display_name: string;
  id: string;
  kind: BroadcastMessageKind;
  moderated_at: Date | null;
  public_id: string;
  sender_id: string;
  status: BroadcastMessageStatus;
  version: number;
};

type ReplayRow = {
  available_at: Date | null;
  media_asset_id: string | null;
  status: BroadcastReplayStatus;
  unavailable_reason: string | null;
};

type RoleTargetRow = {
  call_type: CallType;
  channel_id: string;
  created_by: string;
  organization_id: string;
  participant_status: string;
  provider_identity: string;
  provider_room_name: string;
  role: BroadcastRole;
  session_status: BroadcastStatus;
  target_internal_id: string;
  version: number;
};

const terminalStatuses = new Set<BroadcastStatus>(["ended", "cancelled", "failed"]);
const stageRoles = new Set<BroadcastRole>(["host", "cohost", "speaker"]);
const reactionOrder: BroadcastReaction[] = ["like", "applause", "thanks", "question", "celebrate"];
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function opaqueName(prefix: string, bytes = 24) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

@Injectable()
export class BroadcastsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly livekit: LiveKitProviderService
  ) {}

  capabilities(): CallCapabilities {
    return this.livekit.capabilities();
  }

  async dashboard(principal: AuthPrincipal): Promise<BroadcastDashboard> {
    const channels = await this.database.transaction((client) => this.channels(client, principal));
    return {
      capabilities: this.capabilities(),
      canCreateChannel: principal.state.permissions.canCreateBroadcast && !["guest", "subscriber"].includes(principal.state.role),
      channels
    };
  }

  async createChannel(principal: AuthPrincipal, input: CreateBroadcastChannelInput): Promise<BroadcastChannelSummary> {
    if (!principal.state.permissions.canCreateBroadcast || ["guest", "subscriber"].includes(principal.state.role)) {
      throw new ForbiddenException("This account cannot create a broadcast channel.");
    }
    const handle = input.handle.trim().toLowerCase();
    const name = input.name.trim();
    const description = input.description?.trim() ?? "";
    if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(handle)) {
      throw new BadRequestException("Channel handles use 3-40 lowercase letters, numbers, dot, dash, or underscore.");
    }
    if (name.length < 2 || name.length > 80) throw new BadRequestException("Channel name must contain 2-80 characters.");
    if (description.length > 500) throw new BadRequestException("Channel description is too long.");

    const channelId = randomUUID();
    try {
      await this.database.transaction(async (client) => {
        const owned = await client.query(
          "select 1 from broadcast_channels where owner_id = $1 and archived_at is null limit 5",
          [principal.internalUserId]
        );
        if ((owned.rowCount ?? 0) >= 5) throw new ConflictException("An account can own up to five active channels.");
        const space = await client.query<{ id: string }>(
          `insert into conversation_spaces (
             organization_id, type, name, owner_id, roster_visibility, settings_json
           ) values ($1, 'broadcast_channel', $2, $3, 'subscriber_count_only', $4::jsonb)
           returning id`,
          [
            principal.state.user.organizationId,
            name,
            principal.internalUserId,
            JSON.stringify({ channelId, fileSharingEnabled: false, readReportEnabled: false })
          ]
        );
        const spaceId = space.rows[0]!.id;
        await client.query(
          `insert into space_memberships (space_id, user_id, role, view_mode, status)
           values ($1, $2, 'owner', 'channel', 'active')`,
          [spaceId, principal.internalUserId]
        );
        await client.query(
          `insert into broadcast_channels (
             id, organization_id, space_id, owner_id, handle, name, description, visibility
           ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [channelId, principal.state.user.organizationId, spaceId, principal.internalUserId, handle, name, description, input.visibility]
        );
        await client.query(
          `insert into channel_subscriptions (
             channel_id, user_id, status, notification_level
           ) values ($1, $2, 'active', 'all')`,
          [channelId, principal.internalUserId]
        );
        await this.audit(client, principal, "broadcast.channel.created", "broadcast_channel", channelId, {
          visibility: input.visibility
        });
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new ConflictException("That channel handle is already in use.");
      throw error;
    }
    return this.database.transaction((client) => this.channel(client, channelId, principal));
  }

  async subscribe(
    principal: AuthPrincipal,
    channelId: string,
    notificationLevel: BroadcastNotificationLevel
  ): Promise<BroadcastChannelSummary> {
    await this.database.transaction(async (client) => {
      const channel = await this.lockChannel(client, channelId, principal.state.user.organizationId);
      const existing = await client.query<{ status: BroadcastSubscriptionStatus }>(
        "select status from channel_subscriptions where channel_id = $1 and user_id = $2 for update",
        [channelId, principal.internalUserId]
      );
      if (existing.rows[0]?.status === "blocked") throw new ForbiddenException("This channel subscription is blocked.");
      await client.query(
        `insert into channel_subscriptions (
           channel_id, user_id, status, notification_level, subscribed_at, updated_at
         ) values ($1, $2, 'active', $3, now(), now())
         on conflict (channel_id, user_id) do update set
           status = 'active', notification_level = excluded.notification_level,
           subscribed_at = case when channel_subscriptions.status = 'left' then now() else channel_subscriptions.subscribed_at end,
           left_at = null, blocked_by = null, blocked_at = null, block_reason = null,
           version = channel_subscriptions.version + 1, updated_at = now()`,
        [channelId, principal.internalUserId, notificationLevel]
      );
      await this.audit(client, principal, "broadcast.channel.subscribed", "broadcast_channel", channelId, {
        notificationLevel
      });
      await this.notifyUsers(client, channelId, undefined, "subscription_updated", [channel.owner_id, principal.internalUserId]);
    });
    return this.database.transaction((client) => this.channel(client, channelId, principal));
  }

  async unsubscribe(principal: AuthPrincipal, channelId: string): Promise<BroadcastChannelSummary> {
    await this.database.transaction(async (client) => {
      const channel = await this.lockChannel(client, channelId, principal.state.user.organizationId);
      if (channel.owner_id === principal.internalUserId) throw new ConflictException("A channel owner cannot unsubscribe from their channel.");
      const updated = await client.query<{ status: BroadcastSubscriptionStatus }>(
        `update channel_subscriptions set
           status = 'left', left_at = coalesce(left_at, now()), notification_level = 'off',
           version = version + 1, updated_at = now()
         where channel_id = $1 and user_id = $2 and status in ('active', 'muted', 'left')
         returning status`,
        [channelId, principal.internalUserId]
      );
      if (!updated.rowCount) throw new NotFoundException("Active channel subscription was not found.");
      await this.audit(client, principal, "broadcast.channel.unsubscribed", "broadcast_channel", channelId);
      await this.notifyUsers(client, channelId, undefined, "subscription_updated", [channel.owner_id, principal.internalUserId]);
    });
    return this.database.transaction((client) => this.channel(client, channelId, principal));
  }

  async schedule(principal: AuthPrincipal, channelId: string, input: ScheduleBroadcastInput): Promise<BroadcastSessionView> {
    const scheduledFor = this.parseInstant(input.scheduledFor, "Broadcast start");
    const expectedEndAt = this.parseInstant(input.expectedEndAt, "Broadcast end");
    if (scheduledFor.getTime() < Date.now() - 15 * 60_000) throw new BadRequestException("Broadcast start is too far in the past.");
    if (scheduledFor.getTime() > Date.now() + 366 * 24 * 60 * 60_000) throw new BadRequestException("Broadcasts may be scheduled up to one year ahead.");
    if (expectedEndAt <= scheduledFor || expectedEndAt.getTime() > scheduledFor.getTime() + 12 * 60 * 60_000) {
      throw new BadRequestException("Broadcast duration must be greater than zero and no longer than 12 hours.");
    }
    const title = input.title.trim();
    const description = input.description?.trim() ?? "";
    const requestHash = stableHash({
      callType: input.callType,
      channelId,
      chatMode: input.chatMode,
      description,
      expectedEndAt: expectedEndAt.toISOString(),
      replayRequested: input.replayRequested,
      scheduledFor: scheduledFor.toISOString(),
      title,
      viewerLimit: input.viewerLimit
    });
    const result = await this.database.transaction(async (client) => {
      const channel = await this.lockChannel(client, channelId, principal.state.user.organizationId);
      if (channel.owner_id !== principal.internalUserId) throw new ForbiddenException("Only the channel owner can schedule a broadcast.");
      const existingKey = await client.query<{ request_hash: string; response_json: { broadcastId?: string } | null }>(
        `select request_hash, response_json from idempotency_keys
         where scope = 'broadcast.schedule' and key = $1 and owner_id = $2`,
        [input.clientSessionId, principal.internalUserId]
      );
      if (existingKey.rowCount) {
        const existing = existingKey.rows[0]!;
        if (existing.request_hash !== requestHash) throw new ConflictException("Idempotency key was used for another broadcast.");
        if (!existing.response_json?.broadcastId) throw new ConflictException("The original broadcast is still being created.");
        return existing.response_json.broadcastId;
      }

      await client.query(
        `insert into idempotency_keys (scope, key, owner_id, request_hash, expires_at)
         values ('broadcast.schedule', $1, $2, $3, now() + interval '30 days')`,
        [input.clientSessionId, principal.internalUserId, requestHash]
      );
      const sessionId = randomUUID();
      const providerRoomName = opaqueName("hht_broadcast");
      await client.query(
        `insert into call_sessions (
           id, organization_id, space_id, created_by, call_type, provider_room_name,
           session_kind, status, expires_at
         ) values ($1, $2, $3, $4, $5, $6, 'broadcast', 'scheduled', $7)`,
        [
          sessionId,
          principal.state.user.organizationId,
          channel.space_id,
          principal.internalUserId,
          input.callType,
          providerRoomName,
          new Date(expectedEndAt.getTime() + 60 * 60_000)
        ]
      );
      await client.query(
        `insert into call_participants (
           call_session_id, user_id, role, status, provider_identity,
           can_publish_audio, can_publish_video
         ) values ($1, $2, 'host', 'invited', $3, true, $4)`,
        [sessionId, principal.internalUserId, opaqueName("hht_broadcast_participant"), input.callType === "video"]
      );
      await client.query(
        `insert into broadcast_sessions (
           id, channel_id, call_session_id, created_by, client_session_id, title,
           description, chat_mode, status, scheduled_for, expected_end_at,
           viewer_limit, replay_requested
         ) values ($1, $2, $1, $3, $4, $5, $6, $7, 'scheduled', $8, $9, $10, $11)`,
        [
          sessionId,
          channelId,
          principal.internalUserId,
          input.clientSessionId,
          title,
          description,
          input.chatMode,
          scheduledFor,
          expectedEndAt,
          input.viewerLimit,
          input.replayRequested
        ]
      );
      await client.query(
        `insert into broadcast_replays (broadcast_session_id, status)
         values ($1, 'not_requested')`,
        [sessionId]
      );
      await this.event(client, sessionId, principal.internalUserId, "broadcast.scheduled", {
        chatMode: input.chatMode,
        replayRequested: input.replayRequested,
        viewerLimit: input.viewerLimit
      });
      await this.audit(client, principal, "broadcast.session.scheduled", "broadcast_session", sessionId, {
        chatMode: input.chatMode,
        replayRequested: input.replayRequested,
        viewerLimit: input.viewerLimit
      });
      await client.query(
        `update idempotency_keys set response_json = $4::jsonb, status_code = 201
         where scope = 'broadcast.schedule' and key = $1 and owner_id = $2 and request_hash = $3`,
        [input.clientSessionId, principal.internalUserId, requestHash, JSON.stringify({ broadcastId: sessionId })]
      );
      await this.notifyUsers(client, channelId, sessionId, "scheduled");
      return sessionId;
    });
    return this.get(principal, result);
  }

  async get(principal: AuthPrincipal, sessionId: string): Promise<BroadcastSessionView> {
    await this.expire(sessionId);
    return this.database.transaction((client) => this.project(client, sessionId, principal));
  }

  async start(principal: AuthPrincipal, sessionId: string, version: number): Promise<BroadcastSessionView> {
    if (!this.livekit.capabilities().available) throw new ServiceUnavailableException("Live broadcasting is not configured.");
    const prepared = await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (session.created_by !== principal.internalUserId) throw new ForbiddenException("Only the channel owner can start this broadcast.");
      if (session.status === "live") return { replay: true, session };
      if (!["scheduled", "starting"].includes(session.status)) throw new ConflictException("This broadcast cannot be started.");
      if (session.version !== version && session.status === "scheduled") throw new ConflictException("Broadcast version is stale.");
      if (session.status === "scheduled") {
        await client.query(
          `update broadcast_sessions set status = 'starting', version = version + 1, updated_at = now()
           where id = $1`,
          [sessionId]
        );
        await client.query(
          `update call_sessions set status = 'starting', version = version + 1, updated_at = now()
           where id = $1 and session_kind = 'broadcast'`,
          [sessionId]
        );
        await this.event(client, sessionId, principal.internalUserId, "broadcast.starting");
      }
      return { replay: false, session: { ...session, status: "starting" as const } };
    });
    if (prepared.replay) return this.get(principal, sessionId);

    try {
      await this.livekit.ensureRoom(prepared.session.provider_room_name, prepared.session.viewer_limit + 16);
    } catch (error) {
      await this.failStart(principal, sessionId, "provider_unavailable");
      throw new ServiceUnavailableException(`Broadcast provider could not start: ${this.errorMessage(error)}`);
    }

    await this.database.transaction(async (client) => {
      const updated = await client.query(
        `update broadcast_sessions set
           status = 'live', started_at = coalesce(started_at, now()),
           version = version + 1, updated_at = now()
         where id = $1 and status = 'starting'`,
        [sessionId]
      );
      if (!updated.rowCount) return;
      await client.query(
        `update call_sessions set
           status = 'active', started_at = coalesce(started_at, now()),
           version = version + 1, updated_at = now()
         where id = $1 and session_kind = 'broadcast' and status = 'starting'`,
        [sessionId]
      );
      await client.query(
        `update call_participants set status = 'admitted', admitted_at = coalesce(admitted_at, now()), updated_at = now()
         where call_session_id = $1 and role = 'host' and status = 'invited'`,
        [sessionId]
      );
      await client.query(
        `update broadcast_replays set
           status = case when bs.replay_requested then 'processing' else 'not_requested' end,
          updated_at = now(), version = broadcast_replays.version + 1
         from broadcast_sessions bs
         where broadcast_replays.broadcast_session_id = bs.id and bs.id = $1`,
        [sessionId]
      );
      await this.event(client, sessionId, principal.internalUserId, "broadcast.live");
      await this.audit(client, principal, "broadcast.session.started", "broadcast_session", sessionId);
      const channelId = await this.channelId(client, sessionId);
      await this.notifyUsers(client, channelId, sessionId, "live");
    });
    return this.get(principal, sessionId);
  }

  async join(principal: AuthPrincipal, sessionId: string): Promise<BroadcastJoinView> {
    const prepared = await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (session.status !== "live") throw new ConflictException("The broadcast is not live.");
      const channel = await this.lockChannel(client, session.channel_id, principal.state.user.organizationId);
      const subscription = await client.query<{ status: BroadcastSubscriptionStatus }>(
        "select status from channel_subscriptions where channel_id = $1 and user_id = $2 for update",
        [session.channel_id, principal.internalUserId]
      );
      const owner = channel.owner_id === principal.internalUserId;
      if (!owner && !["active", "muted"].includes(subscription.rows[0]?.status ?? "left")) {
        if (subscription.rows[0]?.status === "blocked") throw new ForbiddenException("This viewer is blocked from the channel.");
        throw new ForbiddenException("Subscribe before joining this broadcast.");
      }
      let participant = await client.query<{
        provider_identity: string;
        role: BroadcastRole;
        status: string;
      }>(
        `select provider_identity, role, status from call_participants
         where call_session_id = $1 and user_id = $2 for update`,
        [sessionId, principal.internalUserId]
      ).then((result) => result.rows[0]);
      if (participant?.status === "removed") throw new ForbiddenException("This viewer was removed from the broadcast.");
      if (!participant) {
        const viewers = await client.query<{ count: string }>(
          `select count(*)::text as count from call_participants
           where call_session_id = $1 and role = 'viewer' and status in ('connecting', 'joined')`,
          [sessionId]
        );
        if (Number(viewers.rows[0]?.count ?? 0) >= session.viewer_limit) throw new ConflictException("The broadcast viewer limit has been reached.");
        const identity = opaqueName("hht_broadcast_viewer");
        await client.query(
          `insert into call_participants (
             call_session_id, user_id, role, status, provider_identity,
             can_publish_audio, can_publish_video, connecting_at
           ) values ($1, $2, 'viewer', 'connecting', $3, false, false, now())`,
          [sessionId, principal.internalUserId, identity]
        );
        participant = { provider_identity: identity, role: "viewer", status: "connecting" };
      } else {
        await client.query(
          `update call_participants set
             status = 'connecting', connecting_at = now(), left_at = null,
             token_version = token_version + 1, updated_at = now()
           where call_session_id = $1 and user_id = $2`,
          [sessionId, principal.internalUserId]
        );
        participant = { ...participant, status: "connecting" };
      }
      await this.event(client, sessionId, principal.internalUserId, "broadcast.participant.connecting", {
        role: participant.role
      });
      await this.notifyUsers(client, session.channel_id, sessionId, "participant_connecting");
      return { participant, session };
    });
    const canPublish = stageRoles.has(prepared.participant.role);
    try {
      const credential = await this.livekit.joinCredential({
        callId: sessionId,
        callType: prepared.session.call_type,
        canPublishAudio: canPublish,
        canPublishVideo: canPublish && prepared.session.call_type === "video",
        displayName: principal.state.user.displayName,
        hidden: prepared.participant.role === "viewer",
        identity: prepared.participant.provider_identity,
        roomName: prepared.session.provider_room_name
      });
      return {
        broadcast: await this.get(principal, sessionId),
        serverUrl: credential.serverUrl,
        token: credential.token,
        tokenExpiresAt: credential.expiresAt.toISOString()
      };
    } catch (error) {
      await this.rollbackJoin(sessionId, principal.internalUserId, prepared.participant.role);
      throw new ServiceUnavailableException(`Broadcast credential could not be issued: ${this.errorMessage(error)}`);
    }
  }

  async connected(principal: AuthPrincipal, sessionId: string): Promise<BroadcastSessionView> {
    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (session.status !== "live") throw new ConflictException("The broadcast is not live.");
      const participant = await client.query<{ status: string }>(
        `select status from call_participants
         where call_session_id = $1 and user_id = $2 for update`,
        [sessionId, principal.internalUserId]
      );
      if (!participant.rows[0]) throw new NotFoundException("Broadcast participant was not found.");
      if (participant.rows[0].status === "joined") return;
      if (participant.rows[0].status !== "connecting") throw new ConflictException("A join credential is required before confirming media.");
      await client.query(
        `update call_participants set status = 'joined', joined_at = coalesce(joined_at, now()), updated_at = now()
         where call_session_id = $1 and user_id = $2`,
        [sessionId, principal.internalUserId]
      );
      await this.event(client, sessionId, principal.internalUserId, "broadcast.participant.joined");
      await this.notifyUsers(client, session.channel_id, sessionId, "participant_joined");
    });
    return this.get(principal, sessionId);
  }

  async leave(principal: AuthPrincipal, sessionId: string): Promise<BroadcastSessionView> {
    const prepared = await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      const participant = await client.query<{ provider_identity: string; role: BroadcastRole; status: string }>(
        `select provider_identity, role, status from call_participants
         where call_session_id = $1 and user_id = $2 for update`,
        [sessionId, principal.internalUserId]
      ).then((result) => result.rows[0]);
      if (!participant) throw new NotFoundException("Broadcast participant was not found.");
      return { participant, session };
    });
    if (["connecting", "joined"].includes(prepared.participant.status)) {
      try {
        await this.livekit.removeParticipant(prepared.session.provider_room_name, prepared.participant.provider_identity);
      } catch (error) {
        if (prepared.participant.role !== "viewer") {
          await this.failProviderSession(principal, sessionId, "participant_revoke_failed");
          throw new ServiceUnavailableException(`Broadcast participant could not be revoked: ${this.errorMessage(error)}`);
        }
      }
    }
    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      await client.query(
        `update call_participants set
           status = case when status = 'removed' then status else 'left' end,
           left_at = coalesce(left_at, now()), token_version = token_version + 1, updated_at = now()
         where call_session_id = $1 and user_id = $2`,
        [sessionId, principal.internalUserId]
      );
      await this.event(client, sessionId, principal.internalUserId, "broadcast.participant.left");
      await this.notifyUsers(client, session.channel_id, sessionId, "participant_left");
    });
    return this.get(principal, sessionId);
  }

  async end(principal: AuthPrincipal, sessionId: string, version: number): Promise<BroadcastSessionView> {
    const prepared = await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (session.created_by !== principal.internalUserId) throw new ForbiddenException("Only the host can end this broadcast.");
      if (terminalStatuses.has(session.status)) return { terminal: true, session };
      if (session.version !== version) throw new ConflictException("Broadcast version is stale.");
      return { terminal: false, session };
    });
    if (prepared.terminal) return this.get(principal, sessionId);
    if (["starting", "live"].includes(prepared.session.status)) {
      try {
        await this.livekit.deleteRoom(prepared.session.provider_room_name);
      } catch (error) {
        await this.failProviderSession(principal, sessionId, "provider_stop_failed");
        throw new ServiceUnavailableException(`Broadcast provider could not stop: ${this.errorMessage(error)}`);
      }
    }
    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (terminalStatuses.has(session.status)) return;
      const status = session.status === "scheduled" ? "cancelled" : "ended";
      const reason = session.status === "scheduled" ? "host_cancelled" : "host_ended";
      await client.query(
        `update broadcast_sessions set
           status = $2, ended_at = now(), end_reason = $3,
           version = version + 1, updated_at = now()
         where id = $1`,
        [sessionId, status, reason]
      );
      await client.query(
        `update call_sessions set
           status = $2, ended_at = now(), end_reason = $3,
           version = version + 1, updated_at = now()
         where id = $1 and session_kind = 'broadcast'`,
        [sessionId, status, reason]
      );
      await client.query(
        `update call_participants set
           status = case when status in ('connecting', 'joined', 'admitted') then 'left' else status end,
           left_at = case when status in ('connecting', 'joined', 'admitted') then now() else left_at end,
           token_version = token_version + 1, updated_at = now()
         where call_session_id = $1`,
        [sessionId]
      );
      await client.query(
        `update broadcast_replays set
           status = case when $2 then 'unavailable' else 'not_requested' end,
           unavailable_reason = case when $2 then 'egress_output_gate_pending' else null end,
           updated_at = now(), version = version + 1
         where broadcast_session_id = $1`,
        [sessionId, session.replay_requested]
      );
      await this.event(client, sessionId, principal.internalUserId, `broadcast.${status}`, { reason });
      await this.audit(client, principal, `broadcast.session.${status}`, "broadcast_session", sessionId, { reason });
      await this.notifyUsers(client, session.channel_id, sessionId, status);
    });
    return this.get(principal, sessionId);
  }

  async changeRole(
    principal: AuthPrincipal,
    sessionId: string,
    targetPublicId: string,
    input: ChangeBroadcastRoleInput
  ): Promise<BroadcastSessionView> {
    const prepared = await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (session.status !== "live") throw new ConflictException("Roles can change only during a live broadcast.");
      if (session.created_by !== principal.internalUserId) throw new ForbiddenException("Only the host can change broadcast roles.");
      if (session.version !== input.version) throw new ConflictException("Broadcast version is stale.");
      const target = await this.roleTarget(client, session, targetPublicId);
      if (target.role === "host") throw new ConflictException("The host role cannot be changed.");
      if (!["connecting", "joined"].includes(target.participant_status)) {
        throw new ConflictException("Only a connected participant can change stage role.");
      }
      return target;
    });
    if (prepared.role === input.role) return this.get(principal, sessionId);
    const oldCanPublish = stageRoles.has(prepared.role);
    const newCanPublish = stageRoles.has(input.role);
    const providerConnected = prepared.participant_status === "joined";

    if (providerConnected && (!newCanPublish || oldCanPublish)) {
      try {
        await this.livekit.updateParticipantPermissions(
          prepared.provider_room_name,
          prepared.provider_identity,
          newCanPublish,
          newCanPublish && prepared.call_type === "video",
          false,
          input.role === "viewer"
        );
      } catch (error) {
        await this.failRoleSync(principal, sessionId, prepared, targetPublicId, input.role, error);
      }
    }

    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (session.version !== input.version) throw new ConflictException("Broadcast version changed during role update.");
      await client.query(
        `update call_participants set
           role = $3, can_publish_audio = $4, can_publish_video = $5,
           role_updated_at = now(), token_version = token_version + 1, updated_at = now()
         where call_session_id = $1 and user_id = $2`,
        [sessionId, prepared.target_internal_id, input.role, newCanPublish, newCanPublish && prepared.call_type === "video"]
      );
      await client.query(
        "update broadcast_sessions set version = version + 1, updated_at = now() where id = $1",
        [sessionId]
      );
      await client.query(
        "update call_sessions set version = version + 1, updated_at = now() where id = $1",
        [sessionId]
      );
      await this.moderation(client, sessionId, principal.internalUserId, "change_role", {
        targetUserId: prepared.target_internal_id,
        metadata: { from: prepared.role, to: input.role }
      });
      await this.event(client, sessionId, principal.internalUserId, "broadcast.role.changed", {
        from: prepared.role,
        to: input.role
      });
      await this.audit(client, principal, "broadcast.participant.role_changed", "broadcast_session", sessionId, {
        from: prepared.role,
        to: input.role
      });
    });

    if (providerConnected && !oldCanPublish && newCanPublish) {
      try {
        await this.livekit.updateParticipantPermissions(
          prepared.provider_room_name,
          prepared.provider_identity,
          true,
          prepared.call_type === "video",
          false,
          false
        );
      } catch (error) {
        await this.failRoleSync(principal, sessionId, prepared, targetPublicId, input.role, error);
      }
    }
    await this.database.transaction(async (client) => {
      await this.notifyUsers(client, prepared.channel_id, sessionId, "role_changed");
    });
    return this.get(principal, sessionId);
  }

  async moderateParticipant(
    principal: AuthPrincipal,
    sessionId: string,
    targetPublicId: string,
    action: "remove" | "block" | "unblock"
  ): Promise<BroadcastSessionView> {
    const prepared = await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      const actor = await this.participant(client, sessionId, principal.internalUserId);
      if (!actor || !["host", "cohost"].includes(actor.role)) throw new ForbiddenException("Broadcast moderation permission is required.");
      const targetUser = await client.query<{ id: string }>(
        `select id from users where public_id = $1 and id <> $2`,
        [targetPublicId, session.created_by]
      ).then((result) => result.rows[0]);
      if (!targetUser) throw new NotFoundException("Broadcast viewer was not found.");
      const target = await this.participant(client, sessionId, targetUser.id);
      if (target?.role === "cohost" && actor.role !== "host") throw new ForbiddenException("Only the host can moderate a cohost.");
      return { actor, session, target, targetInternalId: targetUser.id };
    });
    if (["remove", "block"].includes(action) && prepared.target && ["connecting", "joined"].includes(prepared.target.status)) {
      try {
        await this.livekit.removeParticipant(prepared.session.provider_room_name, prepared.target.provider_identity);
      } catch (error) {
        await this.failProviderSession(principal, sessionId, "moderation_revoke_failed");
        throw new ServiceUnavailableException(`Viewer could not be removed: ${this.errorMessage(error)}`);
      }
    }
    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (action === "remove" || action === "block") {
        await client.query(
          `update call_participants set
             role = case when role = 'host' then role else 'viewer' end,
             status = 'removed', can_publish_audio = false, can_publish_video = false,
             left_at = coalesce(left_at, now()), token_version = token_version + 1, updated_at = now()
           where call_session_id = $1 and user_id = $2 and role <> 'host'`,
          [sessionId, prepared.targetInternalId]
        );
      }
      if (action === "block") {
        await client.query(
          `insert into channel_subscriptions (
             channel_id, user_id, status, notification_level, blocked_by, blocked_at
           ) values ($1, $2, 'blocked', 'off', $3, now())
           on conflict (channel_id, user_id) do update set
             status = 'blocked', notification_level = 'off', blocked_by = excluded.blocked_by,
             blocked_at = now(), block_reason = null, left_at = null,
             version = channel_subscriptions.version + 1, updated_at = now()`,
          [session.channel_id, prepared.targetInternalId, principal.internalUserId]
        );
      } else if (action === "unblock") {
        const unblocked = await client.query(
          `update channel_subscriptions set
             status = 'left', notification_level = 'off', blocked_by = null,
             blocked_at = null, block_reason = null, left_at = now(),
             version = version + 1, updated_at = now()
           where channel_id = $1 and user_id = $2 and status = 'blocked'`,
          [session.channel_id, prepared.targetInternalId]
        );
        if (!unblocked.rowCount) throw new ConflictException("The viewer is not blocked.");
      }
      const actionName = action === "remove" ? "remove_participant" : action === "block" ? "block_subscriber" : "unblock_subscriber";
      await this.moderation(client, sessionId, principal.internalUserId, actionName, {
        targetUserId: prepared.targetInternalId
      });
      await this.event(client, sessionId, principal.internalUserId, `broadcast.participant.${action}`);
      await this.audit(client, principal, `broadcast.participant.${action}`, "broadcast_session", sessionId);
      await this.notifyUsers(client, session.channel_id, sessionId, `participant_${action}`);
    });
    return this.get(principal, sessionId);
  }

  async createMessage(
    principal: AuthPrincipal,
    sessionId: string,
    input: CreateBroadcastMessageInput
  ): Promise<BroadcastSessionView> {
    const body = input.body.trim();
    if (!body) throw new BadRequestException("Broadcast message cannot be empty.");
    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (session.status !== "live") throw new ConflictException("Messages are available only while the broadcast is live.");
      const access = await this.broadcastAccess(client, session, principal.internalUserId);
      const moderator = access.role === "host" || access.role === "cohost";
      if (!access.subscribed && !moderator) throw new ForbiddenException("Subscribe before using broadcast chat.");
      if (input.kind === "announcement" && !moderator) throw new ForbiddenException("Only moderators can publish announcements.");
      if (session.chat_mode === "disabled" && !moderator) throw new ForbiddenException("Broadcast chat is disabled.");
      const existing = await client.query<{ body: string; kind: BroadcastMessageKind }>(
        `select body, kind from broadcast_messages
         where broadcast_session_id = $1 and sender_id = $2 and client_message_id = $3`,
        [sessionId, principal.internalUserId, input.clientMessageId]
      );
      if (existing.rowCount) {
        if (existing.rows[0]!.body !== body || existing.rows[0]!.kind !== input.kind) {
          throw new ConflictException("Message id was already used with different content.");
        }
        return;
      }
      const stage = stageRoles.has(access.role);
      const status: BroadcastMessageStatus = moderator || (input.kind === "chat" && (stage || session.chat_mode === "subscribers"))
        ? "published"
        : "pending";
      await client.query(
        `insert into broadcast_messages (
           broadcast_session_id, sender_id, client_message_id, kind, status, body, anonymous_to_viewers
         ) values ($1, $2, $3, $4, $5, $6, $7)`,
        [sessionId, principal.internalUserId, input.clientMessageId, input.kind, status, body, !stage]
      );
      await this.event(client, sessionId, principal.internalUserId, "broadcast.message.created", {
        kind: input.kind,
        status
      });
      await this.audit(client, principal, "broadcast.message.created", "broadcast_session", sessionId, {
        kind: input.kind,
        status
      });
      if (status === "published") {
        await this.notifyUsers(client, session.channel_id, sessionId, "message_published");
      } else {
        const moderators = await this.moderatorIds(client, sessionId);
        await this.notifyUsers(client, session.channel_id, sessionId, "moderation_queue_updated", [
          ...moderators,
          principal.internalUserId
        ]);
      }
    });
    return this.get(principal, sessionId);
  }

  async moderateMessage(
    principal: AuthPrincipal,
    sessionId: string,
    messageId: string,
    input: ModerateBroadcastMessageInput
  ): Promise<BroadcastSessionView> {
    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      const actor = await this.participant(client, sessionId, principal.internalUserId);
      if (!actor || !["host", "cohost"].includes(actor.role)) throw new ForbiddenException("Broadcast moderation permission is required.");
      const message = await client.query<{ kind: BroadcastMessageKind; status: BroadcastMessageStatus; version: number }>(
        `select kind, status, version from broadcast_messages
         where id = $1 and broadcast_session_id = $2 for update`,
        [messageId, sessionId]
      ).then((result) => result.rows[0]);
      if (!message) throw new NotFoundException("Broadcast message was not found.");
      if (message.version !== input.version) throw new ConflictException("Message version is stale.");
      const next = this.moderatedMessageStatus(message.kind, message.status, input.action);
      await client.query(
        `update broadcast_messages set
           status = $3, moderated_by = $4, moderated_at = now(),
           version = version + 1, updated_at = now()
         where id = $1 and broadcast_session_id = $2`,
        [messageId, sessionId, next, principal.internalUserId]
      );
      const actionName = input.action === "publish"
        ? "publish_message"
        : input.action === "hide"
          ? "hide_message"
          : input.action === "restore"
            ? "restore_message"
            : "dismiss_question";
      await this.moderation(client, sessionId, principal.internalUserId, actionName, { targetMessageId: messageId });
      await this.event(client, sessionId, principal.internalUserId, `broadcast.message.${input.action}`, { kind: message.kind });
      await this.audit(client, principal, `broadcast.message.${input.action}`, "broadcast_session", sessionId, { kind: message.kind });
      await this.notifyUsers(client, session.channel_id, sessionId, "message_moderated");
    });
    return this.get(principal, sessionId);
  }

  async react(
    principal: AuthPrincipal,
    sessionId: string,
    input: SendBroadcastReactionInput
  ): Promise<BroadcastReactionCount[]> {
    return this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (session.status !== "live") throw new ConflictException("Reactions are available only while the broadcast is live.");
      const access = await this.broadcastAccess(client, session, principal.internalUserId);
      if (!access.subscribed && !stageRoles.has(access.role)) throw new ForbiddenException("Subscribe before reacting.");
      const existing = await client.query<{ reaction: BroadcastReaction }>(
        `select reaction from broadcast_reactions
         where broadcast_session_id = $1 and sender_id = $2 and client_reaction_id = $3`,
        [sessionId, principal.internalUserId, input.clientReactionId]
      );
      if (existing.rowCount) {
        if (existing.rows[0]!.reaction !== input.reaction) throw new ConflictException("Reaction id was already used.");
        return this.reactionCounts(client, sessionId);
      }
      const recent = await client.query<{ count: string }>(
        `select count(*)::text as count from broadcast_reactions
         where broadcast_session_id = $1 and sender_id = $2 and created_at > now() - interval '10 seconds'`,
        [sessionId, principal.internalUserId]
      );
      if (Number(recent.rows[0]?.count ?? 0) >= 10) throw new HttpException("Reaction rate limit exceeded.", 429);
      await client.query(
        `insert into broadcast_reactions (
           broadcast_session_id, sender_id, client_reaction_id, reaction
         ) values ($1, $2, $3, $4)`,
        [sessionId, principal.internalUserId, input.clientReactionId, input.reaction]
      );
      await this.notifyUsers(client, session.channel_id, sessionId, "reaction_updated");
      return this.reactionCounts(client, sessionId);
    });
  }

  async privateHandoff(principal: AuthPrincipal, channelId: string): Promise<BroadcastPrivateHandoffView> {
    return this.database.transaction(async (client) => {
      const channel = await this.lockChannel(client, channelId, principal.state.user.organizationId);
      if (channel.owner_id === principal.internalUserId) throw new ConflictException("Channel owner does not need a private handoff.");
      const subscription = await client.query<{ status: BroadcastSubscriptionStatus }>(
        "select status from channel_subscriptions where channel_id = $1 and user_id = $2 for update",
        [channelId, principal.internalUserId]
      ).then((result) => result.rows[0]);
      if (!subscription || !["active", "muted"].includes(subscription.status)) {
        throw new ForbiddenException("An active subscription is required for private service.");
      }
      const existing = await client.query<{ direct_space_id: string }>(
        `select direct_space_id from broadcast_private_handoffs
         where channel_id = $1 and requester_id = $2`,
        [channelId, principal.internalUserId]
      );
      let spaceId = existing.rows[0]?.direct_space_id;
      let created = false;
      if (!spaceId) {
        const direct = await client.query<{ id: string }>(
          `select s.id
           from conversation_spaces s
           join space_memberships sm on sm.space_id = s.id and sm.status = 'active'
           where s.organization_id = $1 and s.type = 'direct' and s.archived_at is null
           group by s.id
           having count(*) = 2
              and count(*) filter (where sm.user_id in ($2, $3)) = 2
           limit 1`,
          [principal.state.user.organizationId, channel.owner_id, principal.internalUserId]
        );
        spaceId = direct.rows[0]?.id;
        if (!spaceId) {
          const inserted = await client.query<{ id: string }>(
            `insert into conversation_spaces (
               organization_id, type, name, owner_id, roster_visibility, settings_json
             ) values ($1, 'direct', $2, $3, 'owner_only', $4::jsonb)
             returning id`,
            [
              principal.state.user.organizationId,
              `${channel.name} private service`,
              channel.owner_id,
              JSON.stringify({ source: "broadcast_private_handoff" })
            ]
          );
          spaceId = inserted.rows[0]!.id;
          await client.query(
            `insert into space_memberships (space_id, user_id, role, view_mode, status)
             values ($1, $2, 'owner', 'shared_room', 'active'),
                    ($1, $3, 'member', 'shared_room', 'active')`,
            [spaceId, channel.owner_id, principal.internalUserId]
          );
          created = true;
        }
        await client.query(
          `insert into broadcast_private_handoffs (channel_id, requester_id, direct_space_id)
           values ($1, $2, $3)
           on conflict (channel_id, requester_id) do nothing`,
          [channelId, principal.internalUserId, spaceId]
        );
      }
      await this.audit(client, principal, "broadcast.private_handoff.requested", "broadcast_channel", channelId);
      await this.notifyUsers(client, channelId, undefined, "private_handoff", [channel.owner_id, principal.internalUserId]);
      return {
        channelId,
        created,
        owner: {
          character: findCharacterPreset(channel.owner_character_id ?? ""),
          displayName: channel.owner_display_name,
          id: channel.owner_public_id
        },
        spaceId
      };
    });
  }

  private async channels(client: PoolClient, principal: AuthPrincipal): Promise<BroadcastChannelSummary[]> {
    const rows = await this.channelRows(client, principal.state.user.organizationId, principal.internalUserId);
    const result: BroadcastChannelSummary[] = [];
    for (const row of rows) result.push(await this.channelProjection(client, row, principal));
    return result;
  }

  private async channel(client: PoolClient, channelId: string, principal: AuthPrincipal): Promise<BroadcastChannelSummary> {
    const row = (await this.channelRows(
      client,
      principal.state.user.organizationId,
      principal.internalUserId,
      channelId,
      true
    ))[0];
    if (!row) throw new NotFoundException("Broadcast channel was not found.");
    return this.channelProjection(client, row, principal);
  }

  private async channelRows(
    client: PoolClient,
    organizationId: string,
    viewerId: string,
    channelId?: string,
    includeKnownUnlisted = false
  ) {
    return client.query<ChannelRow>(
      `select bc.id, bc.organization_id, bc.space_id, bc.owner_id, bc.handle::text,
              bc.name, bc.description, bc.visibility, bc.created_at, bc.updated_at,
              owner.public_id as owner_public_id, owner.display_name as owner_display_name,
              profile.public_profile_json ->> 'characterId' as owner_character_id,
              mine.status as subscription_status, mine.notification_level,
              count(all_sub.user_id) filter (where all_sub.status in ('active', 'muted'))::text as subscriber_count
       from broadcast_channels bc
       join users owner on owner.id = bc.owner_id
       left join profiles profile on profile.user_id = owner.id
       left join channel_subscriptions mine on mine.channel_id = bc.id and mine.user_id = $2
       left join channel_subscriptions all_sub on all_sub.channel_id = bc.id
       where bc.organization_id = $1 and bc.archived_at is null
         and ($3::uuid is null or bc.id = $3)
         and ($4 or bc.visibility = 'organization' or bc.owner_id = $2 or mine.status in ('active', 'muted', 'blocked'))
       group by bc.id, owner.public_id, owner.display_name, owner_character_id,
                mine.status, mine.notification_level
       order by bc.updated_at desc, bc.id`,
      [organizationId, viewerId, channelId ?? null, includeKnownUnlisted]
    ).then((query) => query.rows);
  }

  private async channelProjection(
    client: PoolClient,
    row: ChannelRow,
    principal: AuthPrincipal
  ): Promise<BroadcastChannelSummary> {
    const isOwner = row.owner_id === principal.internalUserId;
    const blocked = row.subscription_status === "blocked";
    const nextSession = await this.sessionSummaryForChannel(client, row.id);
    return {
      canManage: isOwner,
      canSubscribe: !isOwner && !blocked,
      createdAt: row.created_at.toISOString(),
      description: row.description,
      handle: row.handle,
      id: row.id,
      isOwner,
      isSubscribed: ["active", "muted"].includes(row.subscription_status ?? "left"),
      name: row.name,
      ...(nextSession ? { nextSession } : {}),
      ...(row.notification_level ? { notificationLevel: row.notification_level } : {}),
      owner: {
        character: findCharacterPreset(row.owner_character_id ?? ""),
        displayName: row.owner_display_name,
        id: row.owner_public_id
      },
      ...(row.subscription_status ? { subscriptionStatus: row.subscription_status } : {}),
      subscriberCount: Number(row.subscriber_count),
      updatedAt: row.updated_at.toISOString(),
      visibility: row.visibility
    };
  }

  private async sessionSummaryForChannel(client: PoolClient, channelId: string): Promise<BroadcastSessionSummary | undefined> {
    const result = await client.query<SessionRow>(
      `${this.sessionSelect()}
       where bs.channel_id = $1
       order by case bs.status when 'live' then 0 when 'starting' then 1 when 'scheduled' then 2 else 3 end,
                case when bs.status = 'scheduled' then bs.scheduled_for end asc nulls last,
                bs.created_at desc
       limit 1`,
      [channelId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return this.sessionSummary(client, row);
  }

  private async sessionSummary(client: PoolClient, row: SessionRow): Promise<BroadcastSessionSummary> {
    const viewers = await client.query<{ count: string }>(
      `select count(*)::text as count from call_participants
       where call_session_id = $1 and role = 'viewer' and status in ('connecting', 'joined')`,
      [row.id]
    );
    return {
      callType: row.call_type,
      channelId: row.channel_id,
      chatMode: row.chat_mode,
      description: row.description,
      ...(row.ended_at ? { endedAt: row.ended_at.toISOString() } : {}),
      expectedEndAt: row.expected_end_at.toISOString(),
      id: row.id,
      replayStatus: row.replay_status,
      scheduledFor: row.scheduled_for.toISOString(),
      ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
      status: row.status,
      title: row.title,
      viewerCount: Number(viewers.rows[0]?.count ?? 0)
    };
  }

  private async project(client: PoolClient, sessionId: string, principal: AuthPrincipal): Promise<BroadcastSessionView> {
    const session = await client.query<SessionRow>(
      `${this.sessionSelect()}
       where bs.id = $1 and c.organization_id = $2`,
      [sessionId, principal.state.user.organizationId]
    ).then((result) => result.rows[0]);
    if (!session) throw new NotFoundException("Broadcast was not found.");
    const channel = await this.channel(client, session.channel_id, principal);
    const participants = await this.participants(client, sessionId);
    const viewer = participants.find((participant) => participant.user_id === principal.internalUserId);
    const role: BroadcastRole = viewer?.role ?? (channel.isOwner ? "host" : "viewer");
    const status = this.participantStatus(viewer?.status);
    const moderator = role === "host" || role === "cohost";
    const blocked = channel.subscriptionStatus === "blocked";
    const subscribed = channel.isSubscribed || channel.isOwner;
    const messages = await this.messages(client, sessionId, principal.internalUserId, moderator, participants);
    const replay = await client.query<ReplayRow>(
      `select status, unavailable_reason, media_asset_id, available_at
       from broadcast_replays where broadcast_session_id = $1`,
      [sessionId]
    ).then((result) => result.rows[0]);
    const summary = await this.sessionSummary(client, session);
    const onStageParticipants = participants
      .filter((participant) => stageRoles.has(participant.role) && participant.status !== "removed")
      .map((participant) => this.participantProjection(participant, principal.internalUserId));
    const moderationParticipants = moderator
      ? participants.map((participant) => this.participantProjection(participant, principal.internalUserId))
      : undefined;
    return {
      ...summary,
      canAskQuestion: session.status === "live" && subscribed && session.chat_mode !== "disabled" && !blocked,
      canEnd: !terminalStatuses.has(session.status) && role === "host" && session.created_by === principal.internalUserId,
      canJoin: session.status === "live" && subscribed && !blocked && status !== "removed",
      canLeave: session.status === "live" && ["connecting", "joined"].includes(status),
      canManageRoles: session.status === "live" && role === "host" && session.created_by === principal.internalUserId,
      canModerate: session.status === "live" && moderator,
      canRequestPrivateService: !channel.isOwner && subscribed && !blocked,
      canSendChat: session.status === "live" && subscribed && (moderator || session.chat_mode !== "disabled") && !blocked,
      canStart: ["scheduled", "starting"].includes(session.status) && role === "host" && session.created_by === principal.internalUserId,
      channel,
      ...(session.end_reason ? { endReason: session.end_reason } : {}),
      messages,
      ...(moderationParticipants ? { moderationParticipants } : {}),
      myRole: role,
      myStatus: status,
      onStageParticipants,
      reactionCounts: await this.reactionCounts(client, sessionId),
      replay: replay
        ? {
            canOpen: replay.status === "ready" && Boolean(replay.media_asset_id),
            ...(replay.available_at ? { availableAt: replay.available_at.toISOString() } : {}),
            ...(replay.media_asset_id ? { mediaAssetId: replay.media_asset_id } : {}),
            status: replay.status,
            ...(replay.unavailable_reason ? { unavailableReason: replay.unavailable_reason } : {})
          }
        : { canOpen: false, status: "not_requested" },
      version: session.version
    };
  }

  private async messages(
    client: PoolClient,
    sessionId: string,
    viewerId: string,
    moderator: boolean,
    participants: ParticipantRow[]
  ): Promise<BroadcastMessageView[]> {
    const rows = await client.query<MessageRow>(
      `select bm.id, bm.sender_id, bm.kind, bm.status, bm.body,
              bm.anonymous_to_viewers, bm.moderated_at, bm.created_at, bm.version,
              u.public_id, u.display_name,
              p.public_profile_json ->> 'characterId' as character_id
       from broadcast_messages bm
       join users u on u.id = bm.sender_id
       left join profiles p on p.user_id = u.id
       where bm.broadcast_session_id = $1
         and bm.status <> 'deleted'
         and ($3 or bm.status = 'published' or bm.sender_id = $2)
       order by bm.created_at, bm.id
       limit 200`,
      [sessionId, viewerId, moderator]
    ).then((result) => result.rows);
    const roles = new Map(participants.map((participant) => [participant.user_id, participant.role]));
    return rows.map((row) => {
      const senderRole = roles.get(row.sender_id) ?? "viewer";
      const isMine = row.sender_id === viewerId;
      const reveal = moderator || isMine || stageRoles.has(senderRole) || !row.anonymous_to_viewers;
      return {
        body: row.body,
        canModerate: moderator,
        createdAt: row.created_at.toISOString(),
        id: row.id,
        isMine,
        kind: row.kind,
        ...(row.moderated_at ? { moderatedAt: row.moderated_at.toISOString() } : {}),
        ...(reveal
          ? {
              sender: {
                character: findCharacterPreset(row.character_id ?? ""),
                displayName: row.display_name,
                id: row.public_id
              }
            }
          : {}),
        senderLabel: isMine ? "Me" : reveal ? row.display_name : row.kind === "question" ? "Viewer question" : "Viewer",
        senderRole,
        status: row.status,
        version: row.version
      };
    });
  }

  private async participants(client: PoolClient, sessionId: string): Promise<ParticipantRow[]> {
    return client.query<ParticipantRow>(
      `select cp.user_id, cp.role, cp.status, cp.provider_identity,
              cp.can_publish_audio, cp.can_publish_video, cp.joined_at, cp.left_at,
              u.public_id, u.display_name,
              p.public_profile_json ->> 'characterId' as character_id
       from call_participants cp
       join users u on u.id = cp.user_id
       left join profiles p on p.user_id = u.id
       where cp.call_session_id = $1
       order by case cp.role when 'host' then 0 when 'cohost' then 1 when 'speaker' then 2 else 3 end,
                cp.invited_at, cp.user_id`,
      [sessionId]
    ).then((result) => result.rows);
  }

  private participantProjection(participant: ParticipantRow, viewerId: string): BroadcastParticipantView {
    return {
      canPublishAudio: participant.can_publish_audio,
      canPublishVideo: participant.can_publish_video,
      isSelf: participant.user_id === viewerId,
      ...(participant.joined_at ? { joinedAt: participant.joined_at.toISOString() } : {}),
      ...(participant.left_at ? { leftAt: participant.left_at.toISOString() } : {}),
      person: {
        character: findCharacterPreset(participant.character_id ?? ""),
        displayName: participant.display_name,
        id: participant.public_id
      },
      role: participant.role,
      status: this.participantStatus(participant.status)
    };
  }

  private participantStatus(status?: string): BroadcastParticipantStatus {
    if (status === "connecting") return "connecting";
    if (status === "joined") return "joined";
    if (status === "left") return "left";
    if (status === "removed") return "removed";
    return "not_joined";
  }

  private async reactionCounts(client: PoolClient, sessionId: string): Promise<BroadcastReactionCount[]> {
    const rows = await client.query<{ count: string; reaction: BroadcastReaction }>(
      `select reaction, count(*)::text as count from broadcast_reactions
       where broadcast_session_id = $1 group by reaction`,
      [sessionId]
    );
    const counts = new Map(rows.rows.map((row) => [row.reaction, Number(row.count)]));
    return reactionOrder.map((reaction) => ({ count: counts.get(reaction) ?? 0, reaction }));
  }

  private async broadcastAccess(client: PoolClient, session: SessionRow, userId: string) {
    const participant = await this.participant(client, session.id, userId);
    const subscription = await client.query<{ status: BroadcastSubscriptionStatus }>(
      "select status from channel_subscriptions where channel_id = $1 and user_id = $2",
      [session.channel_id, userId]
    ).then((result) => result.rows[0]);
    return {
      role: participant?.role ?? (session.created_by === userId ? "host" : "viewer") as BroadcastRole,
      subscribed: ["active", "muted"].includes(subscription?.status ?? "left") || session.created_by === userId
    };
  }

  private async participant(client: PoolClient, sessionId: string, userId: string) {
    return client.query<{ provider_identity: string; role: BroadcastRole; status: string }>(
      `select provider_identity, role, status from call_participants
       where call_session_id = $1 and user_id = $2`,
      [sessionId, userId]
    ).then((result) => result.rows[0]);
  }

  private async moderatorIds(client: PoolClient, sessionId: string) {
    return client.query<{ user_id: string }>(
      `select user_id from call_participants
       where call_session_id = $1 and role in ('host', 'cohost') and status <> 'removed'`,
      [sessionId]
    ).then((result) => result.rows.map((row) => row.user_id));
  }

  private async roleTarget(client: PoolClient, session: SessionRow, targetPublicId: string): Promise<RoleTargetRow> {
    const result = await client.query<RoleTargetRow>(
      `select cs.organization_id, cs.created_by, cs.call_type, cs.provider_room_name,
              bs.channel_id, bs.status as session_status, bs.version,
              cp.user_id as target_internal_id, cp.role, cp.status as participant_status,
              cp.provider_identity
       from broadcast_sessions bs
       join call_sessions cs on cs.id = bs.call_session_id
       join call_participants cp on cp.call_session_id = bs.id
       join users u on u.id = cp.user_id
       where bs.id = $1 and u.public_id = $2`,
      [session.id, targetPublicId]
    );
    const target = result.rows[0];
    if (!target) throw new NotFoundException("Broadcast participant was not found.");
    return target;
  }

  private async lockChannel(client: PoolClient, channelId: string, organizationId: string) {
    const result = await client.query<{
      name: string;
      organization_id: string;
      owner_character_id: string | null;
      owner_display_name: string;
      owner_id: string;
      owner_public_id: string;
      space_id: string;
    }>(
      `select bc.organization_id, bc.space_id, bc.owner_id, bc.name,
              owner.public_id as owner_public_id, owner.display_name as owner_display_name,
              profile.public_profile_json ->> 'characterId' as owner_character_id
       from broadcast_channels bc
       join users owner on owner.id = bc.owner_id
       left join profiles profile on profile.user_id = owner.id
       where bc.id = $1 and bc.organization_id = $2 and bc.archived_at is null
       for update of bc`,
      [channelId, organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Broadcast channel was not found.");
    return row;
  }

  private async lockSession(client: PoolClient, sessionId: string, organizationId: string): Promise<SessionRow> {
    const result = await client.query<SessionRow>(
      `${this.sessionSelect()}
       where bs.id = $1 and c.organization_id = $2
       for update of bs, c`,
      [sessionId, organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Broadcast was not found.");
    return row;
  }

  private sessionSelect() {
    return `select bs.id, bs.channel_id, bs.created_by, bs.title, bs.description,
                   bs.chat_mode, bs.status, bs.scheduled_for, bs.expected_end_at,
                   bs.viewer_limit, bs.replay_requested, bs.started_at, bs.ended_at,
                   bs.end_reason, bs.created_at, bs.version,
                   c.organization_id, c.space_id, c.call_type, c.provider_room_name,
                   c.status as call_status,
                   coalesce(br.status, 'not_requested') as replay_status
            from broadcast_sessions bs
            join call_sessions c on c.id = bs.call_session_id and c.session_kind = 'broadcast'
            left join broadcast_replays br on br.broadcast_session_id = bs.id`;
  }

  private async channelId(client: PoolClient, sessionId: string) {
    const result = await client.query<{ channel_id: string }>(
      "select channel_id from broadcast_sessions where id = $1",
      [sessionId]
    );
    if (!result.rows[0]) throw new NotFoundException("Broadcast was not found.");
    return result.rows[0].channel_id;
  }

  private async failStart(principal: AuthPrincipal, sessionId: string, reason: string) {
    await this.database.transaction(async (client) => {
      const updated = await client.query<{ channel_id: string }>(
        `update broadcast_sessions set
           status = 'failed', ended_at = now(), end_reason = $2,
           version = version + 1, updated_at = now()
         where id = $1 and status = 'starting'
         returning channel_id`,
        [sessionId, reason]
      );
      if (!updated.rowCount) return;
      await client.query(
        `update call_sessions set
           status = 'failed', ended_at = now(), end_reason = $2,
           version = version + 1, updated_at = now()
         where id = $1 and session_kind = 'broadcast'`,
        [sessionId, reason]
      );
      await client.query(
        `update broadcast_replays set status = 'failed', unavailable_reason = $2,
           updated_at = now(), version = version + 1
         where broadcast_session_id = $1`,
        [sessionId, reason]
      );
      await this.event(client, sessionId, principal.internalUserId, "broadcast.failed", { reason });
      await this.audit(client, principal, "broadcast.session.failed", "broadcast_session", sessionId, { reason });
      await this.notifyUsers(client, updated.rows[0]!.channel_id, sessionId, "failed");
    });
  }

  private async failProviderSession(principal: AuthPrincipal, sessionId: string, reason: string) {
    await this.database.transaction(async (client) => {
      const session = await this.lockSession(client, sessionId, principal.state.user.organizationId);
      if (terminalStatuses.has(session.status)) return;
      await client.query(
        `update broadcast_sessions set
           status = 'failed', ended_at = now(), end_reason = $2,
           version = version + 1, updated_at = now() where id = $1`,
        [sessionId, reason]
      );
      await client.query(
        `update call_sessions set
           status = 'failed', ended_at = now(), end_reason = $2,
           version = version + 1, updated_at = now() where id = $1`,
        [sessionId, reason]
      );
      await client.query(
        `update call_participants set
           status = case when status in ('connecting', 'joined', 'admitted') then 'removed' else status end,
           left_at = case when status in ('connecting', 'joined', 'admitted') then now() else left_at end,
           can_publish_audio = false, can_publish_video = false,
           token_version = token_version + 1, updated_at = now()
         where call_session_id = $1`,
        [sessionId]
      );
      await this.event(client, sessionId, principal.internalUserId, "broadcast.failed", { reason });
      await this.audit(client, principal, "broadcast.session.failed", "broadcast_session", sessionId, { reason });
      await this.notifyUsers(client, session.channel_id, sessionId, "failed");
    });
  }

  private async failRoleSync(
    principal: AuthPrincipal,
    sessionId: string,
    target: RoleTargetRow,
    targetPublicId: string,
    requestedRole: Exclude<BroadcastRole, "host">,
    error: unknown
  ): Promise<never> {
    await this.livekit.removeParticipant(target.provider_room_name, target.provider_identity).catch(() => undefined);
    await this.database.transaction(async (client) => {
      await client.query(
        `update call_participants set
           role = 'viewer', status = 'removed', can_publish_audio = false, can_publish_video = false,
           left_at = coalesce(left_at, now()), token_version = token_version + 1, updated_at = now()
         where call_session_id = $1 and user_id = $2`,
        [sessionId, target.target_internal_id]
      );
      await client.query(
        "update broadcast_sessions set version = version + 1, updated_at = now() where id = $1",
        [sessionId]
      );
      await this.moderation(client, sessionId, principal.internalUserId, "change_role", {
        targetUserId: target.target_internal_id,
        metadata: { failed: true, requestedRole }
      });
      await this.event(client, sessionId, principal.internalUserId, "broadcast.role.sync_failed");
      await this.audit(client, principal, "broadcast.participant.role_sync_failed", "broadcast_session", sessionId);
      await this.notifyUsers(client, target.channel_id, sessionId, "role_sync_failed");
    });
    throw new ServiceUnavailableException(`Broadcast role could not be synchronized for ${targetPublicId}: ${this.errorMessage(error)}`);
  }

  private async rollbackJoin(sessionId: string, userId: string, role: BroadcastRole) {
    await this.database.query(
      `update call_participants set
         status = case when $3 = 'viewer' then 'left' else 'admitted' end,
         left_at = case when $3 = 'viewer' then now() else left_at end,
         token_version = token_version + 1, updated_at = now()
       where call_session_id = $1 and user_id = $2 and status = 'connecting'`,
      [sessionId, userId, role]
    );
  }

  private async expire(sessionId: string) {
    await this.database.transaction(async (client) => {
      const result = await client.query<{ channel_id: string; organization_id: string }>(
        `update broadcast_sessions bs set
           status = 'failed', ended_at = now(), end_reason = 'schedule_expired',
           version = bs.version + 1, updated_at = now()
         from call_sessions c
         where bs.id = $1 and c.id = bs.call_session_id
           and bs.status = 'scheduled' and c.expires_at <= now()
         returning bs.channel_id, c.organization_id`,
        [sessionId]
      );
      if (!result.rowCount) return;
      await client.query(
        `update call_sessions set status = 'expired', ended_at = now(), end_reason = 'schedule_expired',
           version = version + 1, updated_at = now()
         where id = $1 and session_kind = 'broadcast'`,
        [sessionId]
      );
      await this.event(client, sessionId, undefined, "broadcast.expired");
      await this.notifyUsers(client, result.rows[0]!.channel_id, sessionId, "expired");
    });
  }

  private moderatedMessageStatus(
    kind: BroadcastMessageKind,
    status: BroadcastMessageStatus,
    action: BroadcastModerationAction
  ): BroadcastMessageStatus {
    if (action === "publish" && ["pending", "hidden"].includes(status)) return "published";
    if (action === "hide" && status === "published") return "hidden";
    if (action === "restore" && status === "hidden") return "published";
    if (action === "dismiss" && kind === "question" && status === "pending") return "dismissed";
    throw new ConflictException("That moderation action is not valid for the current message state.");
  }

  private parseInstant(value: string, label: string) {
    if (!instantPattern.test(value)) throw new BadRequestException(`${label} must be a UTC ISO timestamp.`);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException(`${label} is invalid.`);
    return parsed;
  }

  private async event(
    client: PoolClient,
    sessionId: string,
    actorId: string | undefined,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ) {
    await client.query(
      `insert into broadcast_events (broadcast_session_id, actor_id, event_type, metadata_json)
       values ($1, $2, $3, $4::jsonb)`,
      [sessionId, actorId ?? null, eventType, JSON.stringify(metadata)]
    );
  }

  private async moderation(
    client: PoolClient,
    sessionId: string,
    actorId: string,
    action: string,
    input: { metadata?: Record<string, unknown>; targetMessageId?: string; targetUserId?: string }
  ) {
    await client.query(
      `insert into broadcast_moderation_actions (
         broadcast_session_id, actor_id, action, target_user_id, target_message_id, metadata_json
       ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        sessionId,
        actorId,
        action,
        input.targetUserId ?? null,
        input.targetMessageId ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );
  }

  private async audit(
    client: PoolClient,
    principal: AuthPrincipal,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {}
  ) {
    await client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [principal.state.user.organizationId, principal.internalUserId, action, targetType, targetId, JSON.stringify(metadata)]
    );
  }

  private async notifyUsers(
    client: PoolClient,
    channelId: string,
    sessionId: string | undefined,
    reason: string,
    exactRecipients?: string[]
  ) {
    const recipientIds = exactRecipients
      ? [...new Set(exactRecipients)]
      : await client.query<{ user_id: string }>(
          `select user_id from channel_subscriptions
           where channel_id = $1 and status in ('active', 'muted')`,
          [channelId]
        ).then((result) => result.rows.map((row) => row.user_id));
    for (const recipientInternalId of recipientIds) {
      await client.query(
        `insert into outbox_events (aggregate_type, aggregate_id, event_type, payload_json)
         values ('broadcast', $1, 'broadcast.updated', $2::jsonb)`,
        [
          sessionId ?? channelId,
          JSON.stringify({
            realtimeEvent: "broadcast:updated",
            realtimePayload: {
              channelId,
              ...(sessionId ? { sessionId } : {}),
              reason
            },
            recipientInternalId
          })
        ]
      );
    }
  }

  private isUniqueViolation(error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
