import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import {
  findCharacterPreset,
  type CreateRemoteSupportInput,
  type DecideRemoteSupportConsentInput,
  type RemoteSupportAgentCredentialView,
  type RemoteSupportAgentMode,
  type RemoteSupportAgentPollView,
  type RemoteSupportAgentActivationView,
  type RemoteSupportCapabilities,
  type RemoteSupportCommandInput,
  type RemoteSupportCommandKind,
  type RemoteSupportCommandStatus,
  type RemoteSupportCommandView,
  type RemoteSupportConsentDecision,
  type RemoteSupportConsentView,
  type RemoteSupportScope,
  type RemoteSupportSessionView,
  type RemoteSupportStatus
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";

type SessionRow = {
  absolute_expires_at: Date;
  agent_mode: RemoteSupportAgentMode;
  approved_at: Date | null;
  call_session_id: string;
  control_epoch: string;
  end_reason: string | null;
  ended_at: Date | null;
  id: string;
  idle_expires_at: Date;
  last_activity_at: Date;
  organization_id: string;
  paused_at: Date | null;
  policy_version: string;
  requested_at: Date;
  requested_scopes: RemoteSupportScope[];
  requester_id: string;
  space_id: string;
  started_at: Date | null;
  status: RemoteSupportStatus;
  target_user_id: string;
};

type SessionProjectionRow = SessionRow & {
  requester_character_id: string | null;
  requester_display_name: string;
  requester_public_id: string;
  target_character_id: string | null;
  target_display_name: string;
  target_public_id: string;
};

type ConsentRow = {
  created_at: Date;
  decided_at: Date | null;
  decision: RemoteSupportConsentDecision;
  expires_at: Date;
  id: string;
  policy_version: string;
  revoked_at: Date | null;
  scope: RemoteSupportScope;
};

type CommandRow = {
  client_command_id: string;
  command_kind: RemoteSupportCommandKind;
  completed_at: Date | null;
  control_epoch: string;
  created_at: Date;
  expires_at: Date;
  id: string;
  payload_json: Record<string, string | number | boolean>;
  request_hash: string;
  result_code: string | null;
  sequence: string;
  status: RemoteSupportCommandStatus;
};

type AgentCredentialRow = SessionRow & {
  agent_instance_id: string | null;
  credential_control_epoch: string;
  credential_id: string;
  credential_status: "active" | "consumed" | "revoked" | "expired";
  credential_expires_at: Date;
};

const policyVersion = "hahatalk-remote-support-v1";
const supportedScopes: RemoteSupportScope[] = ["screen_view", "remote_control"];
const allScopes: RemoteSupportScope[] = ["screen_view", "remote_control", "clipboard", "file_transfer"];
const liveStatuses = new Set<RemoteSupportStatus>(["requested", "approved", "active", "paused"]);
const absoluteMinutes = 30;
const idleMinutes = 5;
const commandTtlSeconds = 10;
const activationTtlSeconds = 120;
const agentTtlMinutes = 15;
const agentOnlineSeconds = 20;
const allowedKeyCodes = new Set([
  "Tab", "Enter", "Escape", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)
]);

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function tokenDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function opaqueToken() {
  return randomBytes(32).toString("base64url");
}

function toIso(value: Date | null | undefined) {
  return value?.toISOString();
}

@Injectable()
export class RemoteSupportService {
  constructor(private readonly database: DatabaseService) {}

  capabilities(): RemoteSupportCapabilities {
    return {
      agent: {
        available: true,
        mode: "dry_run",
        nativeInputAvailable: false,
        reason: "A signed Windows native input agent is required before real input injection can be enabled.",
        signatureRequired: true
      },
      controlPlaneAvailable: true,
      policyVersion,
      protocolVersion: 1,
      screenTransport: "livekit",
      scopes: {
        clipboard: {
          available: false,
          consentRequired: true,
          reason: "Clipboard transfer is fail-closed in Stage 9."
        },
        file_transfer: {
          available: false,
          consentRequired: true,
          reason: "Remote file transfer is fail-closed in Stage 9."
        },
        remote_control: { available: true, consentRequired: true },
        screen_view: { available: true, consentRequired: true }
      },
      sessionLimits: { absoluteMinutes, commandTtlSeconds, idleMinutes }
    };
  }

  async create(principal: AuthPrincipal, input: CreateRemoteSupportInput): Promise<RemoteSupportSessionView> {
    this.assertInternalAccount(principal);
    const scopes = this.normalizeScopes(input.requestedScopes);
    const requestHash = stableHash({
      callId: input.callId,
      requestedScopes: scopes,
      spaceId: input.spaceId,
      targetUserId: input.targetUserId
    });
    const result = await this.database.transaction(async (client) => {
      const existing = await client.query<{ request_hash: string; response_json: { sessionId?: string } | null }>(
        `select request_hash, response_json from idempotency_keys
         where scope = 'remote_support.request' and key = $1 and owner_id = $2`,
        [input.clientRequestId, principal.internalUserId]
      );
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        if (row.request_hash !== requestHash) {
          throw new ConflictException("The remote support request key was reused with different details.");
        }
        if (!row.response_json?.sessionId) {
          throw new ConflictException("The original remote support request is still being processed.");
        }
        return { replay: true, sessionId: row.response_json.sessionId };
      }

      const context = await this.requestContext(client, principal, input.spaceId, input.callId, input.targetUserId);
      await client.query("select pg_advisory_xact_lock(hashtext($1), 19)", [`remote-support:${context.target_internal_id}`]);
      const due = await client.query<SessionRow>(
        `select * from remote_support_sessions
         where target_user_id = $1 and status in ('requested', 'approved', 'active', 'paused')
           and (idle_expires_at <= now() or absolute_expires_at <= now())
         for update`,
        [context.target_internal_id]
      );
      for (const session of due.rows) {
        await this.terminateLocked(client, session, "expired", null, "session_timeout");
      }
      const active = await client.query(
        `select 1 from remote_support_sessions
         where target_user_id = $1 and status in ('requested', 'approved', 'active', 'paused')`,
        [context.target_internal_id]
      );
      if (active.rowCount) {
        throw new ConflictException("The target already has a pending or active remote support session.");
      }

      const claimed = await client.query(
        `insert into idempotency_keys (scope, key, owner_id, request_hash, expires_at)
         values ('remote_support.request', $1, $2, $3, now() + interval '1 day')
         on conflict do nothing returning key`,
        [input.clientRequestId, principal.internalUserId, requestHash]
      );
      if (!claimed.rowCount) throw new ConflictException("The remote support request is already being processed.");

      const sessionId = randomUUID();
      await client.query(
        `insert into remote_support_sessions (
           id, organization_id, space_id, call_session_id, requester_id, target_user_id,
           requested_scopes, policy_version, agent_mode, status,
           absolute_expires_at, idle_expires_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7::text[], $8, 'dry_run', 'requested',
           now() + make_interval(mins => $9), now() + make_interval(mins => $10)
         )`,
        [
          sessionId,
          principal.state.user.organizationId,
          input.spaceId,
          input.callId,
          principal.internalUserId,
          context.target_internal_id,
          scopes,
          policyVersion,
          absoluteMinutes,
          idleMinutes
        ]
      );
      for (const scope of scopes) {
        const disclosureDigest = stableHash({ policyVersion, scope, text: this.disclosure(scope) });
        await client.query(
          `insert into remote_support_consents (
             session_id, subject_user_id, scope, policy_version, disclosure_digest, expires_at
           ) values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
          [sessionId, context.target_internal_id, scope, policyVersion, disclosureDigest, absoluteMinutes]
        );
      }
      await this.event(client, sessionId, principal.internalUserId, null, "remote_support.requested", {
        requestedScopes: scopes
      });
      await this.audit(
        client,
        principal.state.user.organizationId,
        principal.internalUserId,
        sessionId,
        "remote_support.requested",
        { callId: input.callId, requestedScopes: scopes, spaceId: input.spaceId, targetUserId: input.targetUserId }
      );
      await client.query(
        `update idempotency_keys set response_json = $4::jsonb, status_code = 201
         where scope = 'remote_support.request' and key = $1 and owner_id = $2 and request_hash = $3`,
        [input.clientRequestId, principal.internalUserId, requestHash, JSON.stringify({ sessionId })]
      );
      await this.enqueue(client, sessionId);
      return { replay: false, sessionId };
    });
    return this.get(principal, result.sessionId);
  }

  async list(principal: AuthPrincipal, spaceId?: string): Promise<RemoteSupportSessionView[]> {
    const due = await this.database.query<{ id: string }>(
      `select id from remote_support_sessions
       where organization_id = $1 and (requester_id = $2 or target_user_id = $2)
         and status in ('requested', 'approved', 'active', 'paused')
         and (idle_expires_at <= now() or absolute_expires_at <= now())`,
      [principal.state.user.organizationId, principal.internalUserId]
    );
    for (const row of due.rows) await this.expire(row.id);
    return this.database.transaction(async (client) => {
      const sessions = await client.query<{ id: string }>(
        `select id from remote_support_sessions
         where organization_id = $1 and (requester_id = $2 or target_user_id = $2)
           and ($3::uuid is null or space_id = $3)
         order by requested_at desc, id desc limit 30`,
        [principal.state.user.organizationId, principal.internalUserId, spaceId ?? null]
      );
      const views: RemoteSupportSessionView[] = [];
      for (const row of sessions.rows) views.push(await this.project(client, row.id, principal.internalUserId));
      return views;
    });
  }

  async get(principal: AuthPrincipal, sessionId: string): Promise<RemoteSupportSessionView> {
    await this.expire(sessionId);
    return this.database.transaction((client) => this.project(client, sessionId, principal.internalUserId));
  }

  async decide(
    principal: AuthPrincipal,
    sessionId: string,
    input: DecideRemoteSupportConsentInput
  ): Promise<RemoteSupportSessionView> {
    this.assertInternalAccount(principal);
    if (input.policyVersion !== policyVersion) {
      throw new ConflictException("The remote support disclosure has changed. Refresh before responding.");
    }
    await this.expire(sessionId);
    return this.database.transaction(async (client) => {
      const session = await this.lockSession(client, principal, sessionId);
      if (session.target_user_id !== principal.internalUserId) {
        throw new ForbiddenException("Only the target user may respond to remote support consent.");
      }
      if (session.status !== "requested") {
        throw new ConflictException("This remote support request is no longer awaiting consent.");
      }
      const consentResult = await client.query<ConsentRow>(
        `select id, scope, decision, policy_version, created_at, decided_at, expires_at, revoked_at
         from remote_support_consents where session_id = $1 and scope = $2 for update`,
        [sessionId, input.scope]
      );
      const consent = consentResult.rows[0];
      if (!consent) throw new BadRequestException("The requested scope is not part of this session.");
      if (consent.decision !== "pending") {
        if (consent.decision === input.decision) return this.project(client, sessionId, principal.internalUserId);
        throw new ConflictException("This consent scope already has a final decision.");
      }
      await client.query(
        `update remote_support_consents set decision = $3, decided_at = now()
         where session_id = $1 and scope = $2`,
        [sessionId, input.scope, input.decision]
      );
      await this.event(client, sessionId, principal.internalUserId, null, "remote_support.consent_decided", {
        decision: input.decision,
        scope: input.scope
      });
      await this.audit(
        client,
        session.organization_id,
        principal.internalUserId,
        sessionId,
        "remote_support.consent_decided",
        { decision: input.decision, scope: input.scope }
      );
      if (input.decision === "denied") {
        await this.terminateLocked(client, session, "declined", principal.internalUserId, "consent_denied");
        return this.project(client, sessionId, principal.internalUserId);
      }
      const pending = await client.query<{ count: string }>(
        `select count(*)::text as count from remote_support_consents
         where session_id = $1 and decision <> 'granted'`,
        [sessionId]
      );
      if (pending.rows[0]?.count === "0") {
        await client.query(
          `update remote_support_sessions
           set status = 'approved', approved_at = now(), last_activity_at = now(),
               idle_expires_at = least(absolute_expires_at, now() + make_interval(mins => $2)), updated_at = now()
           where id = $1`,
          [sessionId, idleMinutes]
        );
        await this.event(client, sessionId, principal.internalUserId, null, "remote_support.approved");
        await this.audit(client, session.organization_id, principal.internalUserId, sessionId, "remote_support.approved");
      }
      await this.enqueue(client, sessionId);
      return this.project(client, sessionId, principal.internalUserId);
    });
  }

  async createAgentActivation(principal: AuthPrincipal, sessionId: string): Promise<RemoteSupportAgentActivationView> {
    this.assertInternalAccount(principal);
    await this.expire(sessionId);
    const secret = opaqueToken();
    return this.database.transaction(async (client) => {
      const session = await this.lockSession(client, principal, sessionId);
      if (session.target_user_id !== principal.internalUserId) {
        throw new ForbiddenException("Only the target user may activate the remote support agent.");
      }
      if (session.status !== "approved") {
        throw new ConflictException("Grant every requested scope before activating the remote support agent.");
      }
      if (!session.requested_scopes.includes("remote_control")) {
        throw new BadRequestException("A screen-view-only session does not require an input agent.");
      }
      await this.assertCallContextActive(client, session);
      await client.query(
        `update remote_support_agent_credentials
         set status = 'revoked', revoked_at = now()
         where session_id = $1 and status = 'active'`,
        [sessionId]
      );
      const expiresAt = new Date(Math.min(
        session.absolute_expires_at.getTime(),
        Date.now() + activationTtlSeconds * 1_000
      ));
      await client.query(
        `insert into remote_support_agent_credentials (
           session_id, target_user_id, credential_kind, token_digest,
           control_epoch, agent_mode, status, expires_at
         ) values ($1, $2, 'activation', $3, $4, $5, 'active', $6)`,
        [sessionId, principal.internalUserId, tokenDigest(secret), session.control_epoch, session.agent_mode, expiresAt]
      );
      await this.event(client, sessionId, principal.internalUserId, null, "remote_support.agent_activation_issued", {
        expiresInSeconds: activationTtlSeconds,
        mode: session.agent_mode
      });
      await this.audit(
        client,
        session.organization_id,
        principal.internalUserId,
        sessionId,
        "remote_support.agent_activation_issued",
        { mode: session.agent_mode }
      );
      return {
        activationSecret: secret,
        agentMode: session.agent_mode,
        expiresAt: expiresAt.toISOString(),
        sessionId
      };
    });
  }

  pause(principal: AuthPrincipal, sessionId: string) {
    return this.targetTransition(principal, sessionId, "pause");
  }

  resume(principal: AuthPrincipal, sessionId: string) {
    return this.targetTransition(principal, sessionId, "resume");
  }

  revoke(principal: AuthPrincipal, sessionId: string) {
    return this.targetTransition(principal, sessionId, "revoke");
  }

  emergencyStop(principal: AuthPrincipal, sessionId: string) {
    return this.targetTransition(principal, sessionId, "emergency_stop");
  }

  async end(principal: AuthPrincipal, sessionId: string): Promise<RemoteSupportSessionView> {
    await this.expire(sessionId);
    return this.database.transaction(async (client) => {
      const session = await this.lockSession(client, principal, sessionId);
      if (!liveStatuses.has(session.status)) return this.project(client, sessionId, principal.internalUserId);
      await this.terminateLocked(client, session, "ended", principal.internalUserId, "participant_ended");
      return this.project(client, sessionId, principal.internalUserId);
    });
  }

  async sendCommand(
    principal: AuthPrincipal,
    sessionId: string,
    input: RemoteSupportCommandInput
  ): Promise<RemoteSupportCommandView> {
    this.assertInternalAccount(principal);
    await this.expire(sessionId);
    return this.database.transaction(async (client) => {
      const session = await this.lockSession(client, principal, sessionId);
      if (session.requester_id !== principal.internalUserId) {
        throw new ForbiddenException("Only the support requester may send remote input commands.");
      }
      if (session.status !== "active") throw new ConflictException("Remote control is not active.");
      if (!session.requested_scopes.includes("remote_control")) {
        throw new ForbiddenException("Remote control consent was not requested.");
      }
      await this.assertCallContextActive(client, session);
      const consent = await client.query(
        `select 1 from remote_support_consents
         where session_id = $1 and scope = 'remote_control' and decision = 'granted' and expires_at > now()`,
        [sessionId]
      );
      if (!consent.rowCount) throw new ForbiddenException("Remote control consent is not active.");
      const agent = await client.query<{ id: string }>(
        `select id from remote_support_agent_credentials
         where session_id = $1 and credential_kind = 'agent' and status = 'active'
           and control_epoch = $2 and expires_at > now()
           and last_seen_at > now() - make_interval(secs => $3)
         limit 1`,
        [sessionId, session.control_epoch, agentOnlineSeconds]
      );
      if (!agent.rowCount) throw new ConflictException("The target remote support agent is offline.");

      const normalizedPayload = this.normalizeCommand(input.kind, input.payload);
      const requestHash = stableHash({ kind: input.kind, payload: normalizedPayload });
      const replay = await client.query<CommandRow>(
        `select id, client_command_id, request_hash, control_epoch, sequence, command_kind,
                payload_json, status, created_at, expires_at, completed_at, result_code
         from remote_support_commands
         where session_id = $1 and requested_by = $2 and client_command_id = $3`,
        [sessionId, principal.internalUserId, input.clientCommandId]
      );
      if (replay.rowCount) {
        const command = replay.rows[0]!;
        if (command.request_hash !== requestHash) {
          throw new ConflictException("The command key was reused with a different input command.");
        }
        return this.commandView(command);
      }

      const sequence = Number(session.control_epoch) > 0
        ? await client.query<{ sequence: string }>(
            `update remote_support_sessions
             set next_command_sequence = next_command_sequence + 1,
                 last_activity_at = now(),
                 idle_expires_at = least(absolute_expires_at, now() + make_interval(mins => $2)),
                 updated_at = now()
             where id = $1 returning (next_command_sequence - 1)::text as sequence`,
            [sessionId, idleMinutes]
          )
        : undefined;
      const assignedSequence = sequence?.rows[0]?.sequence;
      if (!assignedSequence) throw new ConflictException("A command sequence could not be reserved.");
      const commandId = randomUUID();
      const inserted = await client.query<CommandRow>(
        `insert into remote_support_commands (
           id, session_id, requested_by, client_command_id, request_hash,
           control_epoch, sequence, command_kind, payload_json, status, expires_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'queued', now() + make_interval(secs => $10))
         returning id, client_command_id, request_hash, control_epoch, sequence, command_kind,
                   payload_json, status, created_at, expires_at, completed_at, result_code`,
        [
          commandId,
          sessionId,
          principal.internalUserId,
          input.clientCommandId,
          requestHash,
          session.control_epoch,
          assignedSequence,
          input.kind,
          JSON.stringify(normalizedPayload),
          commandTtlSeconds
        ]
      );
      await this.event(client, sessionId, principal.internalUserId, null, "remote_support.command_queued", {
        commandKind: input.kind,
        sequence: Number(assignedSequence)
      });
      await this.audit(
        client,
        session.organization_id,
        principal.internalUserId,
        sessionId,
        "remote_support.command_queued",
        { commandKind: input.kind, sequence: Number(assignedSequence) }
      );
      await this.enqueue(client, sessionId);
      return this.commandView(inserted.rows[0]!);
    });
  }

  async activateAgent(input: {
    activationSecret: string;
    agentInstanceId: string;
    agentVersion: string;
    deviceId: string;
    platform: string;
  }): Promise<RemoteSupportAgentCredentialView> {
    const agentToken = opaqueToken();
    return this.database.transaction(async (client) => {
      const activation = await client.query<AgentCredentialRow>(
        `select c.id as credential_id, c.status as credential_status,
                c.control_epoch as credential_control_epoch, c.expires_at as credential_expires_at,
                c.agent_instance_id, s.*
         from remote_support_agent_credentials c
         join remote_support_sessions s on s.id = c.session_id
         where c.token_digest = $1 and c.credential_kind = 'activation'
         for update of c, s`,
        [tokenDigest(input.activationSecret)]
      );
      const row = activation.rows[0];
      if (
        !row
        || row.credential_status !== "active"
        || row.credential_expires_at.getTime() <= Date.now()
        || row.control_epoch !== row.credential_control_epoch
      ) {
        throw new UnauthorizedException("Remote support activation is invalid or expired.");
      }
      if (row.status !== "approved") {
        throw new ConflictException("The remote support session is not ready for agent activation.");
      }
      await this.assertCallContextActive(client, row);
      await client.query(
        `update remote_support_agent_credentials
         set status = 'consumed', used_at = now(), agent_instance_id = $2
         where id = $1`,
        [row.credential_id, input.agentInstanceId]
      );
      await client.query(
        `update remote_support_agent_credentials
         set status = 'revoked', revoked_at = now()
         where session_id = $1 and credential_kind = 'agent' and status = 'active'`,
        [row.id]
      );
      const expiresAt = new Date(Math.min(
        row.absolute_expires_at.getTime(),
        Date.now() + agentTtlMinutes * 60_000
      ));
      await client.query(
        `insert into remote_support_agent_credentials (
           session_id, target_user_id, credential_kind, token_digest, control_epoch,
           agent_mode, agent_instance_id, status, last_seen_at, expires_at
         ) values ($1, $2, 'agent', $3, $4, $5, $6, 'active', now(), $7)`,
        [row.id, row.target_user_id, tokenDigest(agentToken), row.control_epoch, row.agent_mode, input.agentInstanceId, expiresAt]
      );
      await client.query(
        `update remote_support_sessions
         set status = 'active', target_device_id = $2,
             started_at = coalesce(started_at, now()), last_activity_at = now(),
             idle_expires_at = least(absolute_expires_at, now() + make_interval(mins => $3)), updated_at = now()
         where id = $1`,
        [row.id, input.deviceId, idleMinutes]
      );
      await this.event(client, row.id, row.target_user_id, input.agentInstanceId, "remote_support.agent_activated", {
        agentVersion: input.agentVersion,
        mode: row.agent_mode,
        platform: input.platform
      });
      await this.audit(client, row.organization_id, row.target_user_id, row.id, "remote_support.agent_activated", {
        agentVersion: input.agentVersion,
        mode: row.agent_mode,
        platform: input.platform
      });
      await this.enqueue(client, row.id);
      return {
        agentMode: row.agent_mode,
        agentToken,
        controlEpoch: Number(row.control_epoch),
        expiresAt: expiresAt.toISOString(),
        sessionId: row.id
      };
    });
  }

  async agentHeartbeat(sessionId: string, token: string | undefined) {
    return this.database.transaction(async (client) => {
      const credential = await this.authenticateAgent(client, sessionId, token);
      if (this.sessionTimedOut(credential)) {
        await this.terminateLocked(client, credential, "expired", null, "session_timeout");
        return { controlEpoch: Number(credential.control_epoch) + 1, sessionStatus: "expired" as const };
      }
      await client.query(
        "update remote_support_agent_credentials set last_seen_at = now() where id = $1",
        [credential.credential_id]
      );
      return {
        controlEpoch: Number(credential.control_epoch),
        sessionStatus: credential.status
      };
    });
  }

  async agentClaimCommands(sessionId: string, token: string | undefined): Promise<RemoteSupportAgentPollView> {
    return this.database.transaction(async (client) => {
      const credential = await this.authenticateAgent(client, sessionId, token);
      if (this.sessionTimedOut(credential)) {
        await this.terminateLocked(client, credential, "expired", null, "session_timeout");
        return {
          commands: [],
          controlEpoch: Number(credential.control_epoch) + 1,
          sessionStatus: "expired"
        };
      }
      await client.query(
        "update remote_support_agent_credentials set last_seen_at = now() where id = $1",
        [credential.credential_id]
      );
      if (credential.status !== "active") {
        return { commands: [], controlEpoch: Number(credential.control_epoch), sessionStatus: credential.status };
      }
      const contextActive = await this.isCallContextActive(client, credential);
      if (!contextActive) {
        await this.pauseLocked(client, credential, null, "screen_share_stopped");
        return {
          commands: [],
          controlEpoch: Number(credential.control_epoch) + 1,
          sessionStatus: "paused"
        };
      }
      await client.query(
        `update remote_support_commands
         set status = 'expired', completed_at = now(), result_code = 'command_ttl_expired'
         where session_id = $1 and status in ('queued', 'claimed') and expires_at <= now()`,
        [sessionId]
      );
      const queued = await client.query<CommandRow>(
        `select id, client_command_id, request_hash, control_epoch, sequence, command_kind,
                payload_json, status, created_at, expires_at, completed_at, result_code
         from remote_support_commands
         where session_id = $1 and control_epoch = $2 and status = 'queued' and expires_at > now()
         order by sequence limit 20 for update skip locked`,
        [sessionId, credential.control_epoch]
      );
      if (queued.rowCount) {
        await client.query(
          `update remote_support_commands
           set status = 'claimed', claimed_by = $2, claimed_at = now()
           where id = any($1::uuid[])`,
          [queued.rows.map((row) => row.id), credential.credential_id]
        );
        for (const row of queued.rows) row.status = "claimed";
        await this.event(
          client,
          sessionId,
          null,
          credential.agent_instance_id,
          "remote_support.commands_claimed",
          { count: queued.rowCount }
        );
      }
      return {
        commands: queued.rows.map((row) => this.commandView(row)),
        controlEpoch: Number(credential.control_epoch),
        sessionStatus: credential.status
      };
    });
  }

  async agentCompleteCommand(
    sessionId: string,
    commandId: string,
    token: string | undefined,
    outcome: "executed" | "simulated" | "rejected",
    resultCode?: string
  ): Promise<RemoteSupportCommandView> {
    return this.database.transaction(async (client) => {
      const credential = await this.authenticateAgent(client, sessionId, token);
      if (this.sessionTimedOut(credential)) {
        await this.terminateLocked(client, credential, "expired", null, "session_timeout");
        const cancelled = await client.query<CommandRow>(
          `select id, client_command_id, request_hash, control_epoch, sequence, command_kind,
                  payload_json, status, created_at, expires_at, completed_at, result_code
           from remote_support_commands where id = $1 and session_id = $2`,
          [commandId, sessionId]
        );
        if (!cancelled.rows[0]) throw new NotFoundException("Remote support command was not found.");
        return this.commandView(cancelled.rows[0]);
      }
      if (credential.agent_mode === "dry_run" && outcome === "executed") {
        throw new BadRequestException("A dry-run agent cannot report native input execution.");
      }
      const commandResult = await client.query<CommandRow & { claimed_by: string | null }>(
        `select id, client_command_id, request_hash, control_epoch, sequence, command_kind,
                payload_json, status, created_at, expires_at, completed_at, result_code, claimed_by
         from remote_support_commands where id = $1 and session_id = $2 for update`,
        [commandId, sessionId]
      );
      const command = commandResult.rows[0];
      if (!command) throw new NotFoundException("Remote support command was not found.");
      if (command.status !== "claimed" || command.claimed_by !== credential.credential_id) {
        throw new ConflictException("The command is not claimed by this agent.");
      }
      const finalOutcome = command.expires_at.getTime() <= Date.now() ? "expired" : outcome;
      const finalCode = finalOutcome === "expired" ? "command_ttl_expired" : resultCode ?? null;
      const updated = await client.query<CommandRow>(
        `update remote_support_commands
         set status = $3, completed_at = now(), result_code = $4
         where id = $1 and session_id = $2
         returning id, client_command_id, request_hash, control_epoch, sequence, command_kind,
                   payload_json, status, created_at, expires_at, completed_at, result_code`,
        [commandId, sessionId, finalOutcome, finalCode]
      );
      await client.query(
        "update remote_support_agent_credentials set last_seen_at = now() where id = $1",
        [credential.credential_id]
      );
      await this.event(client, sessionId, null, credential.agent_instance_id, "remote_support.command_completed", {
        outcome: finalOutcome,
        sequence: Number(command.sequence)
      });
      await this.audit(client, credential.organization_id, credential.target_user_id, sessionId, "remote_support.command_completed", {
        outcome: finalOutcome,
        sequence: Number(command.sequence)
      });
      await this.enqueue(client, sessionId);
      return this.commandView(updated.rows[0]!);
    });
  }

  private async targetTransition(
    principal: AuthPrincipal,
    sessionId: string,
    transition: "pause" | "resume" | "revoke" | "emergency_stop"
  ): Promise<RemoteSupportSessionView> {
    this.assertInternalAccount(principal);
    await this.expire(sessionId);
    return this.database.transaction(async (client) => {
      const session = await this.lockSession(client, principal, sessionId);
      if (session.target_user_id !== principal.internalUserId) {
        throw new ForbiddenException("Only the target user may change remote support control state.");
      }
      if (transition === "pause") {
        if (session.status !== "active") throw new ConflictException("Only an active remote support session can be paused.");
        await this.pauseLocked(client, session, principal.internalUserId, "target_paused");
      } else if (transition === "resume") {
        if (session.status !== "paused") throw new ConflictException("Only a paused remote support session can be resumed.");
        await this.assertCallContextActive(client, session);
        await client.query(
          `update remote_support_sessions
           set status = 'approved', paused_at = null, end_reason = null, last_activity_at = now(),
               idle_expires_at = least(absolute_expires_at, now() + make_interval(mins => $2)), updated_at = now()
           where id = $1`,
          [sessionId, idleMinutes]
        );
        await this.event(client, sessionId, principal.internalUserId, null, "remote_support.resume_approved");
        await this.audit(client, session.organization_id, principal.internalUserId, sessionId, "remote_support.resume_approved");
        await this.enqueue(client, sessionId);
      } else {
        if (!liveStatuses.has(session.status)) return this.project(client, sessionId, principal.internalUserId);
        const reason = transition === "emergency_stop" ? "target_emergency_stop" : "target_revoked";
        await this.terminateLocked(client, session, "revoked", principal.internalUserId, reason);
      }
      return this.project(client, sessionId, principal.internalUserId);
    });
  }

  private async requestContext(
    client: PoolClient,
    principal: AuthPrincipal,
    spaceId: string,
    callId: string,
    targetPublicId: string
  ) {
    const result = await client.query<{
      participant_count: string;
      requester_call_status: string;
      requester_org_role: string;
      space_owner_id: string;
      space_type: string;
      target_call_status: string;
      target_internal_id: string;
      target_org_role: string;
      target_screen_share_status: string;
    }>(
      `select s.type as space_type, s.owner_id as space_owner_id,
              requester_org.role as requester_org_role,
              target_org.role as target_org_role,
              target.id as target_internal_id,
              requester_call.status as requester_call_status,
              target_call.status as target_call_status,
              target_call.screen_share_status as target_screen_share_status,
              (select count(*)::text from call_participants all_cp where all_cp.call_session_id = c.id) as participant_count
       from conversation_spaces s
       join space_memberships requester_space on requester_space.space_id = s.id
         and requester_space.user_id = $3 and requester_space.status in ('active', 'muted')
       join organization_memberships requester_org on requester_org.organization_id = s.organization_id
         and requester_org.user_id = $3 and requester_org.status = 'active'
       join users target on target.public_id = $5
       join space_memberships target_space on target_space.space_id = s.id
         and target_space.user_id = target.id and target_space.status in ('active', 'muted')
       join organization_memberships target_org on target_org.organization_id = s.organization_id
         and target_org.user_id = target.id and target_org.status = 'active'
       join call_sessions c on c.id = $4 and c.space_id = s.id and c.organization_id = s.organization_id
         and c.status = 'active' and c.session_kind = 'ad_hoc'
       join call_participants requester_call on requester_call.call_session_id = c.id and requester_call.user_id = $3
       join call_participants target_call on target_call.call_session_id = c.id and target_call.user_id = target.id
       where s.id = $1 and s.organization_id = $2 and s.archived_at is null`,
      [spaceId, principal.state.user.organizationId, principal.internalUserId, callId, targetPublicId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("A private active call with the target was not found.");
    if (row.target_internal_id === principal.internalUserId) throw new BadRequestException("You cannot remotely support yourself.");
    if ([row.requester_org_role, row.target_org_role].some((role) => role === "guest")) {
      throw new ForbiddenException("Guest accounts cannot participate in remote support.");
    }
    if (!['direct', 'hub', 'open_group'].includes(row.space_type) || row.participant_count !== "2") {
      throw new ForbiddenException("Remote support requires a private two-person call.");
    }
    if (
      row.space_type === "hub"
      && row.space_owner_id !== principal.internalUserId
      && row.space_owner_id !== row.target_internal_id
    ) {
      throw new ForbiddenException("Hub remote support must be between the hub owner and one participant.");
    }
    if (row.requester_call_status !== "joined" || row.target_call_status !== "joined") {
      throw new ConflictException("Both people must be connected to the call before requesting remote support.");
    }
    if (row.target_screen_share_status !== "active") {
      throw new ConflictException("The target must explicitly share a screen before remote support can be requested.");
    }
    return row;
  }

  private normalizeScopes(input: RemoteSupportScope[]) {
    const scopes = [...new Set(input)].sort((left, right) => allScopes.indexOf(left) - allScopes.indexOf(right));
    if (!scopes.includes("screen_view")) throw new BadRequestException("Screen view consent is required for remote support.");
    const unavailable = scopes.find((scope) => !supportedScopes.includes(scope));
    if (unavailable) throw new BadRequestException(`${unavailable} is not available in Stage 9.`);
    return scopes;
  }

  private normalizeCommand(kind: RemoteSupportCommandKind, rawPayload: unknown) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      throw new BadRequestException("Remote input command payload must be an object.");
    }
    const payload = rawPayload as Record<string, unknown>;
    const normalizedCoordinate = (value: unknown, name: string) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new BadRequestException(`${name} must be a normalized number between 0 and 1.`);
      }
      return Math.round(value * 10_000) / 10_000;
    };
    if (kind === "pointer_move") {
      return { x: normalizedCoordinate(payload.x, "x"), y: normalizedCoordinate(payload.y, "y") };
    }
    if (kind === "pointer_button") {
      if (!["click", "down", "up"].includes(String(payload.action))) {
        throw new BadRequestException("Pointer button action is invalid.");
      }
      if (!["left", "middle", "right"].includes(String(payload.button))) {
        throw new BadRequestException("Pointer button is invalid.");
      }
      const coordinates = payload.x === undefined && payload.y === undefined
        ? {}
        : {
            x: normalizedCoordinate(payload.x, "x"),
            y: normalizedCoordinate(payload.y, "y")
          };
      return { action: String(payload.action), button: String(payload.button), ...coordinates };
    }
    if (kind === "wheel") {
      if (
        typeof payload.deltaX !== "number" || !Number.isFinite(payload.deltaX)
        || typeof payload.deltaY !== "number" || !Number.isFinite(payload.deltaY)
        || Math.abs(payload.deltaX) > 1_000 || Math.abs(payload.deltaY) > 1_000
      ) {
        throw new BadRequestException("Wheel deltas must be finite values between -1000 and 1000.");
      }
      return { deltaX: Math.round(payload.deltaX), deltaY: Math.round(payload.deltaY) };
    }
    if (!["press", "down", "up"].includes(String(payload.action)) || !allowedKeyCodes.has(String(payload.code))) {
      throw new BadRequestException("The key command is not in the remote support allowlist.");
    }
    return { action: String(payload.action), code: String(payload.code) };
  }

  private assertInternalAccount(principal: AuthPrincipal) {
    if (["guest", "subscriber"].includes(principal.state.role)) {
      throw new ForbiddenException("Guest accounts cannot use remote support.");
    }
  }

  private sessionTimedOut(session: SessionRow) {
    return session.absolute_expires_at.getTime() <= Date.now() || session.idle_expires_at.getTime() <= Date.now();
  }

  private async lockSession(client: PoolClient, principal: AuthPrincipal, sessionId: string) {
    const result = await client.query<SessionRow>(
      `select * from remote_support_sessions
       where id = $1 and organization_id = $2 and (requester_id = $3 or target_user_id = $3)
       for update`,
      [sessionId, principal.state.user.organizationId, principal.internalUserId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Remote support session was not found.");
    return row;
  }

  private async expire(sessionId: string) {
    await this.database.transaction(async (client) => {
      const result = await client.query<SessionRow>(
        "select * from remote_support_sessions where id = $1 for update",
        [sessionId]
      );
      const session = result.rows[0];
      if (
        session
        && liveStatuses.has(session.status)
        && (session.absolute_expires_at.getTime() <= Date.now() || session.idle_expires_at.getTime() <= Date.now())
      ) {
        await this.terminateLocked(client, session, "expired", null, "session_timeout");
      }
    });
  }

  private async pauseLocked(client: PoolClient, session: SessionRow, actorId: string | null, reason: string) {
    await client.query(
      `update remote_support_sessions
       set status = 'paused', control_epoch = control_epoch + 1,
           paused_at = now(), last_activity_at = now(), updated_at = now(), end_reason = $2
       where id = $1`,
      [session.id, reason]
    );
    await client.query(
      `update remote_support_agent_credentials
       set status = 'revoked', revoked_at = now()
       where session_id = $1 and status = 'active'`,
      [session.id]
    );
    await client.query(
      `update remote_support_commands
       set status = 'cancelled', completed_at = now(), result_code = 'control_epoch_changed'
       where session_id = $1 and status in ('queued', 'claimed')`,
      [session.id]
    );
    await this.event(client, session.id, actorId, null, "remote_support.paused", { reason });
    await this.audit(client, session.organization_id, actorId, session.id, "remote_support.paused", { reason });
    await this.enqueue(client, session.id);
  }

  private async terminateLocked(
    client: PoolClient,
    session: SessionRow,
    status: Extract<RemoteSupportStatus, "ended" | "declined" | "revoked" | "expired" | "failed">,
    actorId: string | null,
    reason: string
  ) {
    if (!liveStatuses.has(session.status)) return;
    await client.query(
      `update remote_support_sessions
       set status = $2, control_epoch = control_epoch + 1, ended_at = now(),
           end_reason = $3, last_activity_at = now(), updated_at = now()
       where id = $1`,
      [session.id, status, reason]
    );
    await client.query(
      `update remote_support_consents
       set decision = 'revoked', decided_at = coalesce(decided_at, now()), revoked_at = now()
       where session_id = $1 and decision in ('pending', 'granted')`,
      [session.id]
    );
    await client.query(
      `update remote_support_agent_credentials
       set status = 'revoked', revoked_at = now()
       where session_id = $1 and status = 'active'`,
      [session.id]
    );
    await client.query(
      `update remote_support_commands
       set status = 'cancelled', completed_at = now(), result_code = 'session_terminated'
       where session_id = $1 and status in ('queued', 'claimed')`,
      [session.id]
    );
    await this.event(client, session.id, actorId, null, `remote_support.${status}`, { reason });
    await this.audit(client, session.organization_id, actorId, session.id, `remote_support.${status}`, { reason });
    await this.enqueue(client, session.id);
  }

  private async authenticateAgent(client: PoolClient, sessionId: string, token: string | undefined) {
    if (!token || token.length < 32 || token.length > 200) {
      throw new UnauthorizedException("Remote support agent authentication is required.");
    }
    const result = await client.query<AgentCredentialRow>(
      `select c.id as credential_id, c.status as credential_status,
              c.control_epoch as credential_control_epoch, c.expires_at as credential_expires_at,
              c.agent_instance_id, s.*
       from remote_support_agent_credentials c
       join remote_support_sessions s on s.id = c.session_id
       where c.session_id = $1 and c.token_digest = $2 and c.credential_kind = 'agent'
       for update of c, s`,
      [sessionId, tokenDigest(token)]
    );
    const row = result.rows[0];
    if (
      !row
      || row.credential_status !== "active"
      || row.credential_expires_at.getTime() <= Date.now()
      || row.control_epoch !== row.credential_control_epoch
    ) {
      throw new UnauthorizedException("Remote support agent credential is invalid or expired.");
    }
    return row;
  }

  private async assertCallContextActive(client: PoolClient, session: SessionRow) {
    if (!await this.isCallContextActive(client, session)) {
      throw new ConflictException("The private call and target screen share must remain active.");
    }
  }

  private async isCallContextActive(client: PoolClient, session: SessionRow) {
    const result = await client.query(
      `select 1 from call_sessions c
       join call_participants requester on requester.call_session_id = c.id and requester.user_id = $2
       join call_participants target on target.call_session_id = c.id and target.user_id = $3
       where c.id = $1 and c.space_id = $4 and c.organization_id = $5
         and c.status = 'active' and c.session_kind = 'ad_hoc'
         and requester.status = 'joined' and target.status = 'joined'
         and target.screen_share_status = 'active'
         and (select count(*) from call_participants cp where cp.call_session_id = c.id) = 2`,
      [session.call_session_id, session.requester_id, session.target_user_id, session.space_id, session.organization_id]
    );
    return Boolean(result.rowCount);
  }

  private async project(client: PoolClient, sessionId: string, viewerInternalId: string): Promise<RemoteSupportSessionView> {
    const sessionResult = await client.query<SessionProjectionRow>(
      `select rs.*,
              requester.public_id as requester_public_id,
              requester.display_name as requester_display_name,
              requester_profile.public_profile_json ->> 'characterId' as requester_character_id,
              target.public_id as target_public_id,
              target.display_name as target_display_name,
              target_profile.public_profile_json ->> 'characterId' as target_character_id
       from remote_support_sessions rs
       join users requester on requester.id = rs.requester_id
       join users target on target.id = rs.target_user_id
       left join profiles requester_profile on requester_profile.user_id = requester.id
       left join profiles target_profile on target_profile.user_id = target.id
       where rs.id = $1 and (rs.requester_id = $2 or rs.target_user_id = $2)`,
      [sessionId, viewerInternalId]
    );
    const session = sessionResult.rows[0];
    if (!session) throw new NotFoundException("Remote support session was not found.");
    const consents = await client.query<ConsentRow>(
      `select id, scope, decision, policy_version, created_at, decided_at, expires_at, revoked_at
       from remote_support_consents where session_id = $1 order by scope`,
      [sessionId]
    );
    const agent = await client.query<{ online: boolean }>(
      `select exists(
         select 1 from remote_support_agent_credentials
         where session_id = $1 and credential_kind = 'agent' and status = 'active'
           and control_epoch = $2 and expires_at > now()
           and last_seen_at > now() - make_interval(secs => $3)
       ) as online`,
      [sessionId, session.control_epoch, agentOnlineSeconds]
    );
    const latestCommand = await client.query<CommandRow>(
      `select id, client_command_id, request_hash, control_epoch, sequence, command_kind,
              payload_json, status, created_at, expires_at, completed_at, result_code
       from remote_support_commands where session_id = $1 order by created_at desc, id desc limit 1`,
      [sessionId]
    );
    const isRequester = viewerInternalId === session.requester_id;
    const isTarget = viewerInternalId === session.target_user_id;
    const agentOnline = agent.rows[0]?.online ?? false;
    const allGranted = consents.rows.length > 0 && consents.rows.every((consent) => consent.decision === "granted");
    const remoteControlGranted = consents.rows.some(
      (consent) => consent.scope === "remote_control" && consent.decision === "granted"
    );
    return {
      absoluteExpiresAt: session.absolute_expires_at.toISOString(),
      agentMode: session.agent_mode,
      agentOnline,
      ...(session.approved_at ? { approvedAt: session.approved_at.toISOString() } : {}),
      callId: session.call_session_id,
      canActivateAgent: isTarget && session.status === "approved" && allGranted && remoteControlGranted,
      canEnd: liveStatuses.has(session.status),
      canPause: isTarget && session.status === "active",
      canRespond: isTarget && session.status === "requested" && consents.rows.some((row) => row.decision === "pending"),
      canResume: isTarget && session.status === "paused",
      canSendCommands: isRequester && session.status === "active" && agentOnline && remoteControlGranted,
      consents: consents.rows.map((row) => this.consentView(row)),
      controlEpoch: Number(session.control_epoch),
      ...(session.ended_at ? { endedAt: session.ended_at.toISOString() } : {}),
      ...(session.end_reason ? { endReason: session.end_reason } : {}),
      id: session.id,
      idleExpiresAt: session.idle_expires_at.toISOString(),
      isRequester,
      isTarget,
      lastActivityAt: session.last_activity_at.toISOString(),
      ...(latestCommand.rows[0] ? { latestCommand: this.commandView(latestCommand.rows[0]) } : {}),
      ...(session.paused_at ? { pausedAt: session.paused_at.toISOString() } : {}),
      requestedAt: session.requested_at.toISOString(),
      requestedScopes: session.requested_scopes,
      requester: {
        character: findCharacterPreset(session.requester_character_id ?? ""),
        displayName: session.requester_display_name,
        id: session.requester_public_id
      },
      spaceId: session.space_id,
      ...(session.started_at ? { startedAt: session.started_at.toISOString() } : {}),
      status: session.status,
      target: {
        character: findCharacterPreset(session.target_character_id ?? ""),
        displayName: session.target_display_name,
        id: session.target_public_id
      }
    };
  }

  private consentView(row: ConsentRow): RemoteSupportConsentView {
    return {
      createdAt: row.created_at.toISOString(),
      ...(row.decided_at ? { decidedAt: row.decided_at.toISOString() } : {}),
      decision: row.decision,
      expiresAt: row.expires_at.toISOString(),
      id: row.id,
      policyVersion: row.policy_version,
      ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
      scope: row.scope
    };
  }

  private commandView(row: CommandRow): RemoteSupportCommandView {
    return {
      clientCommandId: row.client_command_id,
      ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
      controlEpoch: Number(row.control_epoch),
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      id: row.id,
      kind: row.command_kind,
      payload: row.payload_json,
      ...(row.result_code ? { resultCode: row.result_code } : {}),
      sequence: Number(row.sequence),
      status: row.status
    };
  }

  private async enqueue(client: PoolClient, sessionId: string) {
    const participants = await client.query<{ user_id: string }>(
      `select requester_id as user_id from remote_support_sessions where id = $1
       union select target_user_id from remote_support_sessions where id = $1`,
      [sessionId]
    );
    for (const participant of participants.rows) {
      const projection = await this.project(client, sessionId, participant.user_id);
      await client.query(
        `insert into outbox_events (aggregate_type, aggregate_id, event_type, payload_json)
         values ('remote_support', $1, 'remote_support.session.updated', $2::jsonb)`,
        [sessionId, JSON.stringify({
          recipientInternalId: participant.user_id,
          realtimeEvent: "remote-support:updated",
          realtimePayload: projection
        })]
      );
    }
  }

  private event(
    client: PoolClient,
    sessionId: string,
    actorId: string | null,
    agentInstanceId: string | null,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ) {
    return client.query(
      `insert into remote_support_events (session_id, actor_id, agent_instance_id, event_type, metadata_json)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [sessionId, actorId, agentInstanceId, eventType, JSON.stringify(metadata)]
    );
  }

  private audit(
    client: PoolClient,
    organizationId: string,
    actorId: string | null,
    sessionId: string,
    action: string,
    metadata: Record<string, unknown> = {}
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, 'remote_support_session', $4, $5::jsonb)`,
      [organizationId, actorId, action, sessionId, JSON.stringify(metadata)]
    );
  }

  private disclosure(scope: RemoteSupportScope) {
    if (scope === "screen_view") return "The requester can view only the screen explicitly shared in the private call.";
    if (scope === "remote_control") return "The requester can send allowlisted pointer and keyboard commands until pause, revoke, or timeout.";
    if (scope === "clipboard") return "Clipboard transfer is separately consented and disabled in Stage 9.";
    return "File transfer is separately consented and disabled in Stage 9.";
  }
}
