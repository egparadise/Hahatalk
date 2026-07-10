import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import {
  createAuthSession,
  demoOrganization,
  demoRoom,
  findCharacterPreset,
  normalizeEmail,
  type LoginInput,
  type MemberRole,
  type SignupInput,
  type User
} from "@hahatalk/contracts";
import { argon2id, hash, needsRehash, verify } from "argon2";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service.js";
import { readSessionToken } from "./auth-cookie.js";
import type { AuthPrincipal, CreatedAuthSession } from "./auth.types.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const passwordHashOptions = {
  memoryCost: 19_456,
  parallelism: 1,
  timeCost: 2,
  type: argon2id
} as const;
const absoluteSessionMilliseconds = 12 * 60 * 60 * 1_000;
const idleSessionMilliseconds = 2 * 60 * 60 * 1_000;

type AccountRow = {
  auth_version: number;
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

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest();
}

function toIso(value: Date | null | undefined, fallback = new Date()) {
  return (value ?? fallback).toISOString();
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

@Injectable()
export class AuthService {
  private readonly dummyPasswordHash = hash("HahaTalk dummy password material", passwordHashOptions);

  constructor(private readonly database: DatabaseService) {}

  async signup(input: SignupInput, userAgent?: string): Promise<CreatedAuthSession> {
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    const passwordHash = await hash(input.password, passwordHashOptions);
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
          await client.query(
            `update users
             set display_name = $2, password_hash = $3, status = 'active', account_claimed_at = now(),
                 password_changed_at = now(), updated_at = now()
             where id = $1`,
            [account.internal_user_id, displayName, passwordHash]
          );
          await client.query(
            `update organization_memberships
             set status = 'active', joined_at = coalesce(joined_at, now())
             where user_id = $1 and organization_id = $2`,
            [account.internal_user_id, account.organization_id]
          );
          await this.upsertProfile(client, account.internal_user_id, character.id);
          await this.writeAudit(client, account.organization_id, account.internal_user_id, "auth.account_claimed", account.internal_user_id);
          return account.public_id;
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
    const passwordHash = account?.password_hash ?? await this.dummyPasswordHash;
    const passwordMatches = await verify(passwordHash, input.password).catch(() => false);

    if (!account || !passwordMatches || account.status !== "active" || account.membership_status !== "active") {
      throw new UnauthorizedException("Email or password is incorrect.");
    }

    if (needsRehash(passwordHash, passwordHashOptions)) {
      const upgradedHash = await hash(input.password, passwordHashOptions);
      await this.database.query(
        "update users set password_hash = $2, password_changed_at = now(), updated_at = now() where id = $1",
        [account.internal_user_id, upgradedHash]
      );
    }

    return this.createSession(account.public_id, userAgent);
  }

  async authenticateCookieHeader(cookieHeader?: string) {
    const token = readSessionToken(cookieHeader);
    return token ? this.authenticateToken(token) : undefined;
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
      await client.query(
        "update web_sessions set revoked_at = now(), revoke_reason = 'logout' where id = $1 and revoked_at is null",
        [principal.sessionId]
      );
      await this.writeAudit(
        client,
        principal.state.user.organizationId,
        principal.internalUserId,
        "auth.session_revoked",
        principal.sessionId
      );
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

  private rowToPrincipal(row: SessionRow): AuthPrincipal {
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
      sessionId: row.session_id,
      state: createAuthSession(
        user,
        row.role,
        demoRoom.id,
        toIso(row.session_created_at),
        demoRoom,
        toIso(row.expires_at)
      )
    };
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
