import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import {
  createAuthSession,
  demoOrganization,
  demoRoom,
  findCharacterPreset,
  normalizeEmail,
  type LoginInput,
  type MemberRole,
  type MobileLoginInput,
  type MobileRefreshInput,
  type SignupInput,
  type DeviceSessionView,
  type User
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service.js";
import { defaultHubSpaceId } from "../modules/conversation.constants.js";
import { readSessionToken } from "./auth-cookie.js";
import { hashPassword, passwordNeedsRehash, verifyPassword } from "./password.js";
import type { AuthPrincipal, CreatedAuthSession, CreatedMobileAuthSession } from "./auth.types.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const absoluteSessionMilliseconds = 12 * 60 * 60 * 1_000;
const idleSessionMilliseconds = 2 * 60 * 60 * 1_000;
const mobileAccessMilliseconds = 15 * 60 * 1_000;
const mobileIdleMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const mobileAbsoluteMilliseconds = 90 * 24 * 60 * 60 * 1_000;

type AccountRow = {
  auth_version: number;
  bootstrap_claim_allowed: boolean;
  character_id: string | null;
  created_at: Date;
  display_name: string;
  email: string;
  internal_user_id: string;
  last_seen_at: Date | null;
  membership_status: string;
  organization_id: string;
  password_hash: string | null;
  public_id: string;
  role: MemberRole;
  status: string;
};

type SessionRow = AccountRow & {
  expires_at: Date;
  session_created_at: Date;
  session_id: string;
};

type DeviceSessionRow = {
  created_at: Date;
  expires_at: Date;
  id: string;
  last_seen_at: Date;
  user_agent: string | null;
};

type MobileSessionRow = SessionRow & {
  mobile_installation_hash: string;
  mobile_platform: "android" | "ios";
};

type MobileRefreshRow = MobileSessionRow & {
  refresh_created_at: Date;
  refresh_expires_at: Date;
  refresh_generation: number;
  refresh_id: string;
  refresh_status: "active" | "rotated" | "revoked" | "reused" | "expired";
  mobile_absolute_expires_at: Date;
  mobile_idle_expires_at: Date;
  mobile_session_auth_version: number;
};

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest();
}

function installationHash(installationId: string) {
  return createHash("sha256").update(installationId.trim().toLowerCase()).digest();
}

function mobileToken(prefix: "hha" | "hhr") {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function toIso(value: Date | null | undefined, fallback = new Date()) {
  return (value ?? fallback).toISOString();
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService) {}

  async signup(input: SignupInput, userAgent?: string): Promise<CreatedAuthSession> {
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    const passwordHash = await hashPassword(input.password);
    const character = findCharacterPreset(input.characterId);

    let publicId: string;
    try {
      publicId = await this.database.transaction(async (client) => {
        const existing = await client.query<AccountRow>(
          this.accountSelect("where u.email = $1", "for update of u"),
          [email]
        );
        const account = existing.rows[0];

        if (account?.password_hash) {
          throw new ConflictException("An account already exists for this email.");
        }

        if (account) {
          if (!account.bootstrap_claim_allowed && process.env.HAHATALK_ALLOW_OPEN_SIGNUP !== "true") {
            throw new ForbiddenException("A valid invitation is required for this email.");
          }
          await client.query(
            `update users
             set display_name = $2, password_hash = $3, status = 'active', account_claimed_at = now(),
                 password_changed_at = now(), bootstrap_claim_allowed = false, updated_at = now()
             where id = $1`,
            [account.internal_user_id, displayName, passwordHash]
          );
          await client.query(
            `update organization_memberships
             set status = 'active', joined_at = coalesce(joined_at, now())
             where user_id = $1 and organization_id = $2`,
            [account.internal_user_id, account.organization_id]
          );
          await this.ensureDefaultHubMembership(
            client,
            account.organization_id,
            account.internal_user_id,
            account.role
          );
          await this.upsertProfile(client, account.internal_user_id, character.id);
          await this.writeAudit(client, account.organization_id, account.internal_user_id, "auth.account_claimed", account.internal_user_id);
          return account.public_id;
        }

        if (process.env.HAHATALK_ALLOW_OPEN_SIGNUP !== "true") {
          throw new ForbiddenException("A valid invitation is required for this email.");
        }

        const internalUserId = randomUUID();
        const nextPublicId = `usr_${randomUUID().replaceAll("-", "")}`;
        await client.query(
          `insert into users (
             id, public_id, email, password_hash, display_name, status, account_claimed_at, password_changed_at
           ) values ($1, $2, $3, $4, $5, 'active', now(), now())`,
          [internalUserId, nextPublicId, email, passwordHash, displayName]
        );
        await client.query(
          `insert into organization_memberships (organization_id, user_id, role, status, joined_at)
           values ($1, $2, 'member', 'active', now())`,
          [organizationId, internalUserId]
        );
        await this.ensureDefaultHubMembership(client, organizationId, internalUserId, "member");
        await this.upsertProfile(client, internalUserId, character.id);
        await this.writeAudit(client, organizationId, internalUserId, "auth.account_created", internalUserId);
        return nextPublicId;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("An account already exists for this email.");
      }
      throw error;
    }

    return this.createSession(publicId, userAgent);
  }

  async login(input: LoginInput, userAgent?: string): Promise<CreatedAuthSession> {
    const email = normalizeEmail(input.email);
    const accountResult = await this.database.query<AccountRow>(this.accountSelect("where u.email = $1"), [email]);
    const account = accountResult.rows[0];
    const { candidateHash: passwordHash, matches: passwordMatches } = await verifyPassword(account?.password_hash, input.password);

    if (!account || !passwordMatches || account.status !== "active" || account.membership_status !== "active") {
      throw new UnauthorizedException("Email or password is incorrect.");
    }

    if (passwordNeedsRehash(passwordHash)) {
      const upgradedHash = await hashPassword(input.password);
      await this.database.query(
        "update users set password_hash = $2, password_changed_at = now(), updated_at = now() where id = $1",
        [account.internal_user_id, upgradedHash]
      );
    }

    return this.createSession(account.public_id, userAgent);
  }

  async mobileLogin(input: MobileLoginInput): Promise<CreatedMobileAuthSession> {
    const email = normalizeEmail(input.email);
    const accountResult = await this.database.query<AccountRow>(this.accountSelect("where u.email = $1"), [email]);
    const account = accountResult.rows[0];
    const { candidateHash: passwordHash, matches: passwordMatches } = await verifyPassword(account?.password_hash, input.password);

    if (!account || !passwordMatches || account.status !== "active" || account.membership_status !== "active") {
      throw new UnauthorizedException("Email or password is incorrect.");
    }
    if (passwordNeedsRehash(passwordHash)) {
      const upgradedHash = await hashPassword(input.password);
      await this.database.query(
        "update users set password_hash = $2, password_changed_at = now(), updated_at = now() where id = $1",
        [account.internal_user_id, upgradedHash]
      );
    }
    return this.createMobileSession(account, input);
  }

  async mobileRefresh(input: MobileRefreshInput): Promise<CreatedMobileAuthSession> {
    if (!input.refreshToken.startsWith("hhr_") || input.refreshToken.length > 160) {
      throw new UnauthorizedException("Mobile refresh credential is invalid.");
    }
    const nextAccessToken = mobileToken("hha");
    const nextRefreshToken = mobileToken("hhr");
    const requestedInstallationHash = installationHash(input.installationId);
    const result = await this.database.transaction(async (client) => {
      const refreshed = await client.query<MobileRefreshRow>(
        `select
           mrt.id as refresh_id,
           mrt.status as refresh_status,
           mrt.generation as refresh_generation,
           mrt.created_at as refresh_created_at,
           mrt.expires_at as refresh_expires_at,
           ms.id as session_id,
           ms.created_at as session_created_at,
           ms.access_expires_at as expires_at,
           ms.idle_expires_at as mobile_idle_expires_at,
           ms.absolute_expires_at as mobile_absolute_expires_at,
           ms.session_auth_version as mobile_session_auth_version,
           ms.platform as mobile_platform,
           encode(ms.installation_id_hash, 'hex') as mobile_installation_hash,
           u.id as internal_user_id,
           u.public_id,
           u.email::text,
           u.password_hash,
           u.display_name,
           u.status,
           u.auth_version,
           u.bootstrap_claim_allowed,
           u.last_seen_at,
           u.created_at,
           om.organization_id,
           om.role,
           om.status as membership_status,
           p.public_profile_json ->> 'characterId' as character_id
         from mobile_refresh_tokens mrt
         join mobile_sessions ms on ms.id = mrt.session_id
         join users u on u.id = ms.user_id
         join organization_memberships om on om.user_id = u.id and om.organization_id = ms.organization_id
         left join profiles p on p.user_id = u.id
         where mrt.token_hash = $1
         order by om.created_at asc
         limit 1
         for update of mrt, ms`,
        [tokenHash(input.refreshToken)]
      );
      const row = refreshed.rows[0];
      if (!row) return { invalid: true as const };

      const now = new Date();
      const installationMatches = row.mobile_installation_hash === requestedInstallationHash.toString("hex");
      const valid = row.refresh_status === "active"
        && row.refresh_expires_at.getTime() > now.getTime()
        && row.mobile_idle_expires_at.getTime() > now.getTime()
        && row.mobile_absolute_expires_at.getTime() > now.getTime()
        && row.mobile_session_auth_version === row.auth_version
        && row.membership_status === "active"
        && row.status === "active"
        && row.mobile_platform === input.platform
        && installationMatches;
      if (!valid) {
        const reuse = row.refresh_status !== "active";
        await this.revokeMobileSessionLocked(client, row.session_id, reuse ? "refresh_token_reused" : "refresh_invalid");
        if (reuse) {
          await client.query(
            "update mobile_refresh_tokens set status = 'reused' where id = $1 and status <> 'active'",
            [row.refresh_id]
          );
        }
        await this.writeAudit(
          client,
          row.organization_id,
          row.internal_user_id,
          reuse ? "auth.mobile_refresh_reuse" : "auth.mobile_refresh_rejected",
          row.session_id
        );
        return { invalid: true as const };
      }

      const accessExpiresAt = new Date(now.getTime() + mobileAccessMilliseconds);
      const idleExpiresAt = new Date(Math.min(
        row.mobile_absolute_expires_at.getTime(),
        now.getTime() + mobileIdleMilliseconds
      ));
      await client.query(
        `update mobile_refresh_tokens
         set status = 'rotated', consumed_at = now()
         where id = $1 and status = 'active'`,
        [row.refresh_id]
      );
      await client.query(
        `insert into mobile_refresh_tokens (session_id, token_hash, generation, expires_at)
         values ($1, $2, $3, $4)`,
        [row.session_id, tokenHash(nextRefreshToken), row.refresh_generation + 1, row.mobile_absolute_expires_at]
      );
      await client.query(
        `update mobile_sessions
         set access_token_hash = $2, access_expires_at = $3, idle_expires_at = $4,
             app_version = $5, last_seen_at = now()
         where id = $1`,
        [row.session_id, tokenHash(nextAccessToken), accessExpiresAt, idleExpiresAt, input.appVersion]
      );
      await this.writeAudit(client, row.organization_id, row.internal_user_id, "auth.mobile_refreshed", row.session_id);
      const principal = this.rowToPrincipal(
        { ...row, expires_at: accessExpiresAt },
        "mobile",
        row.mobile_installation_hash
      );
      return {
        invalid: false as const,
        value: {
          accessExpiresAt: accessExpiresAt.toISOString(),
          accessToken: nextAccessToken,
          principal,
          refreshExpiresAt: row.mobile_absolute_expires_at.toISOString(),
          refreshToken: nextRefreshToken,
          session: principal.state
        }
      };
    });
    if (result.invalid) throw new UnauthorizedException("Mobile refresh credential is invalid or expired.");
    return result.value;
  }

  async authenticateCookieHeader(cookieHeader?: string) {
    const token = readSessionToken(cookieHeader);
    return token ? this.authenticateToken(token) : undefined;
  }

  async authenticateBearerHeader(authorizationHeader?: string) {
    const match = authorizationHeader?.match(/^Bearer (hha_[A-Za-z0-9_-]{40,150})$/);
    return match?.[1] ? this.authenticateMobileToken(match[1]) : undefined;
  }

  async authenticateMobileToken(token: string): Promise<AuthPrincipal | undefined> {
    const result = await this.database.query<MobileSessionRow>(
      `select
         ms.id as session_id,
         ms.created_at as session_created_at,
         ms.access_expires_at as expires_at,
         ms.platform as mobile_platform,
         encode(ms.installation_id_hash, 'hex') as mobile_installation_hash,
         u.id as internal_user_id,
         u.public_id,
         u.email::text,
         u.password_hash,
         u.display_name,
         u.status,
         u.auth_version,
         u.bootstrap_claim_allowed,
         u.last_seen_at,
         u.created_at,
         om.organization_id,
         om.role,
         om.status as membership_status,
         p.public_profile_json ->> 'characterId' as character_id
       from mobile_sessions ms
       join users u on u.id = ms.user_id
       join organization_memberships om on om.user_id = u.id and om.organization_id = ms.organization_id
       left join profiles p on p.user_id = u.id
       where ms.access_token_hash = $1
         and ms.revoked_at is null
         and ms.access_expires_at > now()
         and ms.idle_expires_at > now()
         and ms.absolute_expires_at > now()
         and ms.session_auth_version = u.auth_version
         and u.status = 'active'
         and om.status = 'active'
       order by om.created_at asc
       limit 1`,
      [tokenHash(token)]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    await this.database.query(
      `update mobile_sessions
       set last_seen_at = now(), idle_expires_at = least(absolute_expires_at, now() + interval '30 days')
       where id = $1 and last_seen_at < now() - interval '5 minutes'`,
      [row.session_id]
    );
    return this.rowToPrincipal(row, "mobile", row.mobile_installation_hash);
  }

  async authenticateToken(token: string): Promise<AuthPrincipal | undefined> {
    if (token.length < 32 || token.length > 128) {
      return undefined;
    }

    const result = await this.database.query<SessionRow>(
      `select
         ws.id as session_id,
         ws.created_at as session_created_at,
         ws.expires_at,
         u.id as internal_user_id,
         u.public_id,
         u.email::text,
         u.password_hash,
         u.display_name,
         u.status,
         u.auth_version,
         u.bootstrap_claim_allowed,
         u.last_seen_at,
         u.created_at,
         om.organization_id,
         om.role,
         om.status as membership_status,
         p.public_profile_json ->> 'characterId' as character_id
       from web_sessions ws
       join users u on u.id = ws.user_id
       join organization_memberships om on om.user_id = u.id
       left join profiles p on p.user_id = u.id
       where ws.token_hash = $1
         and ws.revoked_at is null
         and ws.idle_expires_at > now()
         and ws.expires_at > now()
         and ws.session_auth_version = u.auth_version
         and u.status = 'active'
         and om.status = 'active'
       order by om.created_at asc
       limit 1`,
      [tokenHash(token)]
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    await this.database.query(
      `update web_sessions
       set last_seen_at = now(), idle_expires_at = least(expires_at, now() + interval '2 hours')
       where id = $1 and last_seen_at < now() - interval '5 minutes'`,
      [row.session_id]
    );
    await this.database.query(
      "update users set last_seen_at = now() where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '5 minutes')",
      [row.internal_user_id]
    );

    return this.rowToPrincipal(row);
  }

  async logout(principal: AuthPrincipal) {
    await this.database.transaction(async (client) => {
      if (principal.sessionKind === "mobile") {
        await this.revokeMobileSessionLocked(client, principal.sessionId, "logout");
      } else {
        await client.query(
          "update web_sessions set revoked_at = now(), revoke_reason = 'logout' where id = $1 and revoked_at is null",
          [principal.sessionId]
        );
      }
      await this.writeAudit(
        client,
        principal.state.user.organizationId,
        principal.internalUserId,
        "auth.session_revoked",
        principal.sessionId
      );
    });
  }

  async listSessions(principal: AuthPrincipal): Promise<DeviceSessionView[]> {
    const result = await this.database.query<DeviceSessionRow>(
      `select id, user_agent, created_at, last_seen_at, expires_at
       from web_sessions
       where user_id = $1 and revoked_at is null and expires_at > now() and idle_expires_at > now()
       order by last_seen_at desc`,
      [principal.internalUserId]
    );

    return result.rows.map((row) => ({
      createdAt: row.created_at.toISOString(),
      current: row.id === principal.sessionId,
      expiresAt: row.expires_at.toISOString(),
      id: row.id,
      lastSeenAt: row.last_seen_at.toISOString(),
      userAgent: row.user_agent || "알 수 없는 기기"
    }));
  }

  async revokeSession(principal: AuthPrincipal, sessionId: string) {
    const result = await this.database.transaction(async (client) => {
      const revoked = await client.query<{ id: string }>(
        `update web_sessions
         set revoked_at = now(), revoke_reason = 'user_session_revoke'
         where id = $1 and user_id = $2 and revoked_at is null
         returning id`,
        [sessionId, principal.internalUserId]
      );
      if (!revoked.rowCount) {
        throw new NotFoundException("Active session was not found.");
      }
      await this.writeAudit(
        client,
        principal.state.user.organizationId,
        principal.internalUserId,
        "auth.session_revoked_by_user",
        sessionId
      );
      return revoked.rows[0]!;
    });

    return { current: result.id === principal.sessionId, ok: true };
  }

  async revokeOtherSessions(principal: AuthPrincipal) {
    return this.database.transaction(async (client) => {
      const revoked = await client.query(
        `update web_sessions
         set revoked_at = now(), revoke_reason = 'user_revoke_other_sessions'
         where user_id = $1 and id <> $2 and revoked_at is null`,
        [principal.internalUserId, principal.sessionId]
      );
      await this.writeAudit(
        client,
        principal.state.user.organizationId,
        principal.internalUserId,
        "auth.other_sessions_revoked",
        principal.sessionId
      );
      return { ok: true, revokedCount: revoked.rowCount ?? 0 };
    });
  }

  private async createSession(publicId: string, userAgent?: string): Promise<CreatedAuthSession> {
    const accountResult = await this.database.query<AccountRow>(this.accountSelect("where u.public_id = $1"), [publicId]);
    const account = accountResult.rows[0];
    if (!account || account.status !== "active" || account.membership_status !== "active") {
      throw new UnauthorizedException("Account is not active.");
    }

    const cookieToken = randomBytes(32).toString("base64url");
    const now = new Date();
    const idleExpiresAt = new Date(now.getTime() + idleSessionMilliseconds);
    const expiresAt = new Date(now.getTime() + absoluteSessionMilliseconds);
    const result = await this.database.transaction(async (client) => {
      const inserted = await client.query<{ created_at: Date; expires_at: Date; id: string }>(
        `insert into web_sessions (
           user_id, token_hash, session_auth_version, user_agent, idle_expires_at, expires_at
         ) values ($1, $2, $3, $4, $5, $6)
         returning id, created_at, expires_at`,
        [
          account.internal_user_id,
          tokenHash(cookieToken),
          account.auth_version,
          userAgent?.slice(0, 512) || null,
          idleExpiresAt,
          expiresAt
        ]
      );
      const session = inserted.rows[0]!;
      await this.writeAudit(client, account.organization_id, account.internal_user_id, "auth.session_created", session.id);
      return session;
    });

    const principal = this.rowToPrincipal({
      ...account,
      expires_at: result.expires_at,
      session_created_at: result.created_at,
      session_id: result.id
    });
    return { cookieToken, principal };
  }

  private async createMobileSession(account: AccountRow, input: MobileLoginInput): Promise<CreatedMobileAuthSession> {
    const accessToken = mobileToken("hha");
    const refreshToken = mobileToken("hhr");
    const hashedInstallationId = installationHash(input.installationId);
    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + mobileAccessMilliseconds);
    const idleExpiresAt = new Date(now.getTime() + mobileIdleMilliseconds);
    const absoluteExpiresAt = new Date(now.getTime() + mobileAbsoluteMilliseconds);
    const result = await this.database.transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        `select id from mobile_sessions
         where user_id = $1 and installation_id_hash = $2 and revoked_at is null
         for update`,
        [account.internal_user_id, hashedInstallationId]
      );
      for (const session of existing.rows) {
        await this.revokeMobileSessionLocked(client, session.id, "installation_relogin");
      }
      const inserted = await client.query<{ created_at: Date; id: string }>(
        `insert into mobile_sessions (
           organization_id, user_id, platform, installation_id_hash, access_token_hash,
           session_auth_version, app_version, access_expires_at, idle_expires_at, absolute_expires_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id, created_at`,
        [
          account.organization_id,
          account.internal_user_id,
          input.platform,
          hashedInstallationId,
          tokenHash(accessToken),
          account.auth_version,
          input.appVersion,
          accessExpiresAt,
          idleExpiresAt,
          absoluteExpiresAt
        ]
      );
      const session = inserted.rows[0]!;
      await client.query(
        `insert into mobile_refresh_tokens (session_id, token_hash, generation, expires_at)
         values ($1, $2, 1, $3)`,
        [session.id, tokenHash(refreshToken), absoluteExpiresAt]
      );
      await this.writeAudit(client, account.organization_id, account.internal_user_id, "auth.mobile_session_created", session.id);
      return session;
    });
    const principal = this.rowToPrincipal(
      {
        ...account,
        expires_at: accessExpiresAt,
        session_created_at: result.created_at,
        session_id: result.id
      },
      "mobile",
      hashedInstallationId.toString("hex")
    );
    return {
      accessExpiresAt: accessExpiresAt.toISOString(),
      accessToken,
      principal,
      refreshExpiresAt: absoluteExpiresAt.toISOString(),
      refreshToken,
      session: principal.state
    };
  }

  private rowToPrincipal(
    row: SessionRow,
    sessionKind: "mobile" | "web" = "web",
    mobileInstallationHash?: string
  ): AuthPrincipal {
    const character = findCharacterPreset(row.character_id ?? "");
    const user: User = {
      character,
      displayName: row.display_name,
      email: row.email,
      id: row.public_id,
      lastSeenAt: toIso(row.last_seen_at),
      organizationId: row.organization_id || demoOrganization.id,
      status: "active"
    };
    return {
      internalUserId: row.internal_user_id,
      ...(mobileInstallationHash ? { mobileInstallationHash } : {}),
      sessionId: row.session_id,
      sessionKind,
      state: createAuthSession(
        user,
        row.role,
        defaultHubSpaceId,
        toIso(row.session_created_at),
        demoRoom,
        toIso(row.expires_at)
      )
    };
  }

  private async revokeMobileSessionLocked(client: PoolClient, sessionId: string, reason: string) {
    await client.query(
      `update mobile_sessions
       set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, $2)
       where id = $1`,
      [sessionId, reason]
    );
    await client.query(
      `update mobile_refresh_tokens
       set status = 'revoked', consumed_at = coalesce(consumed_at, now())
       where session_id = $1 and status = 'active'`,
      [sessionId]
    );
    const devices = await client.query<{ id: string }>(
      `update mobile_devices
       set status = 'revoked', revoked_at = now(), revoke_reason = $2, updated_at = now()
       where mobile_session_id = $1 and status = 'active'
       returning id`,
      [sessionId, reason]
    );
    if (devices.rowCount) {
      await client.query(
        `update mobile_push_jobs
         set status = 'cancelled', completed_at = now(), updated_at = now(), last_error_code = 'device_revoked'
         where device_id = any($1::uuid[]) and status in ('queued', 'claimed')`,
        [devices.rows.map((device) => device.id)]
      );
    }
  }

  private accountSelect(suffix: string, tail = "") {
    return `
      select
        u.id as internal_user_id,
        u.public_id,
        u.email::text,
        u.password_hash,
        u.display_name,
        u.status,
        u.auth_version,
        u.bootstrap_claim_allowed,
        u.last_seen_at,
        u.created_at,
        om.organization_id,
        om.role,
        om.status as membership_status,
        p.public_profile_json ->> 'characterId' as character_id
      from users u
      join organization_memberships om on om.user_id = u.id
      left join profiles p on p.user_id = u.id
      ${suffix}
      order by om.created_at asc
      limit 1
      ${tail}
    `;
  }

  private upsertProfile(client: PoolClient, internalUserId: string, characterId: string) {
    return client.query(
      `insert into profiles (user_id, public_profile_json)
       values ($1, jsonb_build_object('characterId', $2::text))
       on conflict (user_id) do update
       set public_profile_json = profiles.public_profile_json || excluded.public_profile_json,
           updated_at = now()`,
      [internalUserId, characterId]
    );
  }

  private async ensureDefaultHubMembership(
    client: PoolClient,
    memberOrganizationId: string,
    internalUserId: string,
    role: MemberRole
  ) {
    const hub = await client.query<{ id: string; owner_id: string }>(
      `select id, owner_id
       from conversation_spaces
       where organization_id = $1 and type = 'hub' and archived_at is null
         and (settings_json ->> 'isDefault')::boolean is true
       order by created_at
       limit 1`,
      [memberOrganizationId]
    );
    const space = hub.rows[0];
    if (!space) {
      return;
    }
    const isOwner = space.owner_id === internalUserId;
    await client.query(
      `insert into space_memberships (space_id, user_id, role, view_mode, status, joined_at)
       values ($1, $2, $3, $4, 'active', now())
       on conflict (space_id, user_id) do update
       set role = excluded.role, view_mode = excluded.view_mode, status = 'active'`,
      [space.id, internalUserId, isOwner ? "owner" : role, isOwner ? "owner_console" : "direct_with_owner"]
    );
    if (!isOwner) {
      await client.query(
        `insert into hub_spokes (space_id, owner_id, participant_id)
         values ($1, $2, $3)
         on conflict (space_id, participant_id) do update
         set owner_id = excluded.owner_id, archived_at = null`,
        [space.id, space.owner_id, internalUserId]
      );
    }
  }

  private writeAudit(
    client: PoolClient,
    auditOrganizationId: string,
    actorId: string,
    action: string,
    targetId: string
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id)
       values ($1, $2, $3, 'auth_session', $4)`,
      [auditOrganizationId, actorId, action, targetId]
    );
  }
}
