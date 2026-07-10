import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import {
  findCharacterPreset,
  normalizeEmail,
  type ApprovalPolicy,
  type CreatedMembershipInvitation,
  type InvitationAcceptanceResult,
  type InvitationDecision,
  type InvitationPreview,
  type InvitationStatus,
  type MembershipInvitationView,
  type MemberRole
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import { hashPassword } from "../auth/password.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";

const termsPolicyVersion = "hahatalk-terms-2026-07";
const privacyPolicyVersion = "hahatalk-privacy-2026-07";
const groupJoinPolicyVersion = "hahatalk-group-join-2026-07";
const activeInvitationStatuses = new Set<InvitationStatus>(["pending_approval", "sent"]);

type CreateInvitationInput = {
  approvalPolicy?: ApprovalPolicy;
  email: string;
  expiresInHours?: number;
  requiredApprovalCount?: number;
  role: "member" | "guest";
};

type AcceptInvitationInput = {
  acceptGroupJoin: boolean;
  acceptPrivacy: boolean;
  acceptTerms: boolean;
  characterId?: string;
  displayName?: string;
  inviteCode: string;
  password?: string;
};

type InvitationRow = {
  accepted_by: string | null;
  activated_at: Date | null;
  approval_policy: ApprovalPolicy;
  created_at: Date;
  expires_at: Date;
  id: string;
  invited_by: string;
  invitee_decided_at: Date | null;
  invitee_decision: "accepted" | "declined" | null;
  invitee_email: string;
  invitee_user_id: string | null;
  max_uses: number;
  organization_id: string;
  requested_role: "member" | "guest";
  required_approval_count: number;
  status: InvitationStatus;
  use_count: number;
};

type InvitationViewRow = InvitationRow & {
  approved_count: number;
  inviter_display_name: string;
  my_decision: InvitationDecision | null;
  organization_name: string;
  required_for_current: boolean;
};

type ApproverRow = {
  internal_user_id: string;
  role: "owner" | "admin" | "member";
};

type InviteeAccountRow = {
  display_name: string;
  id: string;
  password_hash: string | null;
  public_id: string;
  status: string;
};

function inviteDigest(inviteCode: string) {
  return createHash("sha256").update(inviteCode.trim()).digest();
}

function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  const visible = local.slice(0, 1);
  const hidden = "*".repeat(Math.max(2, Math.min(6, local.length - 1)));
  return `${visible}${hidden}@${domain}`;
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

@Injectable()
export class InvitationService {
  constructor(private readonly database: DatabaseService) {}

  async create(principal: AuthPrincipal, input: CreateInvitationInput): Promise<CreatedMembershipInvitation> {
    if (!principal.state.permissions.canInviteGuests || !["owner", "admin"].includes(principal.state.role)) {
      throw new ForbiddenException("Invitation management permission is required.");
    }

    const email = normalizeEmail(input.email);
    const approvalPolicy = input.approvalPolicy ?? "owner_and_invitee";
    const expiresInHours = input.expiresInHours ?? 72;
    const inviteCode = `hti_${randomBytes(32).toString("base64url")}`;

    try {
      return await this.database.transaction(async (client) => {
        await this.expireInvitations(client, principal.state.user.organizationId);
        await this.assertManagerMembership(client, principal);

        const existingMembership = await client.query<{ status: string }>(
          `select om.status
           from users u
           join organization_memberships om on om.user_id = u.id
           where u.email = $1 and om.organization_id = $2`,
          [email, principal.state.user.organizationId]
        );
        if (existingMembership.rows[0]?.status === "active") {
          throw new ConflictException("This email already has an active membership.");
        }

        const existingUser = await client.query<{ id: string }>("select id from users where email = $1", [email]);
        const approvers = await this.selectApprovers(client, principal.state.user.organizationId, approvalPolicy);
        if (approvers.length === 0) {
          throw new BadRequestException("The approval policy has no eligible approvers.");
        }

        const requiredApprovalCount = approvalPolicy === "quorum_and_invitee"
          ? input.requiredApprovalCount ?? Math.min(2, approvers.length)
          : approvers.length;
        if (requiredApprovalCount > approvers.length) {
          throw new BadRequestException("Required approval count exceeds eligible approvers.");
        }

        const inserted = await client.query<InvitationRow>(
          `insert into invitations (
             organization_id, invited_by, invitee_user_id, invitee_email, requested_role,
             approval_policy, required_approval_count, status, token_digest, expires_at
           ) values ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', $8, now() + ($9 * interval '1 hour'))
           returning *`,
          [
            principal.state.user.organizationId,
            principal.internalUserId,
            existingUser.rows[0]?.id ?? null,
            email,
            input.role,
            approvalPolicy,
            requiredApprovalCount,
            inviteDigest(inviteCode),
            expiresInHours
          ]
        );
        const invitation = inserted.rows[0]!;

        for (const approver of approvers) {
          await client.query(
            `insert into invitation_approval_requirements (invitation_id, approver_id, role_snapshot)
             values ($1, $2, $3)`,
            [invitation.id, approver.internal_user_id, approver.role]
          );
        }

        if (approvers.some((approver) => approver.internal_user_id === principal.internalUserId)) {
          await client.query(
            `insert into invitation_approvals (invitation_id, approver_id, decision, note)
             values ($1, $2, 'approved', 'inviter approval')`,
            [invitation.id, principal.internalUserId]
          );
          await this.writeAudit(client, invitation.organization_id, principal.internalUserId, "invitation.approved", invitation.id, {
            automatic: 1,
            policy: approvalPolicy
          });
        }

        const approvedCount = await this.approvedCount(client, invitation.id);
        const status: InvitationStatus = approvedCount >= requiredApprovalCount ? "sent" : "pending_approval";
        await client.query("update invitations set status = $2, updated_at = now() where id = $1", [invitation.id, status]);
        await this.writeAudit(client, invitation.organization_id, principal.internalUserId, "invitation.created", invitation.id, {
          approvalPolicy,
          requestedRole: input.role,
          requiredApprovalCount
        });

        return {
          approvalPolicy,
          approvedCount,
          canDecide: false,
          canManage: true,
          createdAt: invitation.created_at.toISOString(),
          email,
          expiresAt: invitation.expires_at.toISOString(),
          id: invitation.id,
          inviteCode,
          inviterDisplayName: principal.state.user.displayName,
          requiredApprovalCount,
          role: input.role,
          status
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("An active invitation already exists for this email.");
      }
      throw error;
    }
  }

  async list(principal: AuthPrincipal): Promise<MembershipInvitationView[]> {
    return this.database.transaction(async (client) => {
      await this.expireInvitations(client, principal.state.user.organizationId);
      const managerView = principal.state.permissions.canInviteGuests;
      const result = await client.query<InvitationViewRow>(
        `select
           i.*,
           inviter.display_name as inviter_display_name,
           o.name as organization_name,
           (select count(*)::int from invitation_approvals ia
             where ia.invitation_id = i.id and ia.decision = 'approved') as approved_count,
           exists(select 1 from invitation_approval_requirements iar
             where iar.invitation_id = i.id and iar.approver_id = $2) as required_for_current,
           (select ia.decision from invitation_approvals ia
             where ia.invitation_id = i.id and ia.approver_id = $2) as my_decision
         from invitations i
         join users inviter on inviter.id = i.invited_by
         join organizations o on o.id = i.organization_id
         where i.organization_id = $1
           and ($3::boolean or i.invited_by = $2 or exists(
             select 1 from invitation_approval_requirements iar
             where iar.invitation_id = i.id and iar.approver_id = $2
           ))
         order by i.created_at desc`,
        [principal.state.user.organizationId, principal.internalUserId, managerView]
      );
      return result.rows.map((row) => this.toView(row, principal));
    });
  }

  async preview(inviteCode: string): Promise<InvitationPreview> {
    if (await this.expireByCode(inviteCode)) {
      throw new GoneException("Invitation has expired.");
    }
    return this.database.transaction(async (client) => {
      const row = await this.invitationByCode(client, inviteCode);
      await this.assertCodeUsable(client, row);
      const details = await client.query<{
        account_claimed: boolean;
        inviter_display_name: string;
        organization_name: string;
      }>(
        `select
           inviter.display_name as inviter_display_name,
           o.name as organization_name,
           coalesce(invitee.account_claimed_at is not null, false) as account_claimed
         from invitations i
         join users inviter on inviter.id = i.invited_by
         join organizations o on o.id = i.organization_id
         left join users invitee on invitee.id = i.invitee_user_id or invitee.email = i.invitee_email
         where i.id = $1
         limit 1`,
        [row.id]
      );
      const detail = details.rows[0]!;
      return {
        accountClaimed: detail.account_claimed,
        emailMasked: maskEmail(row.invitee_email),
        expiresAt: row.expires_at.toISOString(),
        inviterDisplayName: detail.inviter_display_name,
        organizationName: detail.organization_name,
        role: row.requested_role
      };
    });
  }

  async accept(
    input: AcceptInvitationInput,
    principal?: AuthPrincipal,
    userAgent?: string
  ): Promise<InvitationAcceptanceResult> {
    if (!input.acceptTerms || !input.acceptPrivacy || !input.acceptGroupJoin) {
      throw new BadRequestException("Terms, privacy, and group join consent are required.");
    }
    if (await this.expireByCode(input.inviteCode)) {
      throw new GoneException("Invitation has expired.");
    }
    const preparedPasswordHash = input.password ? await hashPassword(input.password) : undefined;

    return this.database.transaction(async (client) => {
      const invitation = await this.invitationByCode(client, input.inviteCode);
      await this.assertCodeUsable(client, invitation);
      const accountResult = await client.query<InviteeAccountRow>(
        `select id, public_id, password_hash, display_name, status
         from users
         where id = $1 or email = $2
         order by case when id = $1 then 0 else 1 end
         limit 1
         for update`,
        [invitation.invitee_user_id, invitation.invitee_email]
      );
      let account = accountResult.rows[0];

      if (account?.password_hash) {
        if (!principal || principal.internalUserId !== account.id) {
          throw new UnauthorizedException("Sign in with the invited account before accepting this invitation.");
        }
      } else {
        const displayName = input.displayName?.trim();
        if (!displayName || !preparedPasswordHash) {
          throw new BadRequestException("Display name and a new password are required to activate this invitation.");
        }
        const character = findCharacterPreset(input.characterId ?? "");
        if (account) {
          await client.query(
            `update users
             set display_name = $2, password_hash = $3, account_claimed_at = now(),
                 password_changed_at = now(), updated_at = now()
             where id = $1`,
            [account.id, displayName, preparedPasswordHash]
          );
        } else {
          const accountId = randomUUID();
          const publicId = `usr_${randomUUID().replaceAll("-", "")}`;
          await client.query(
            `insert into users (
               id, public_id, email, password_hash, display_name, status, account_claimed_at, password_changed_at
             ) values ($1, $2, $3, $4, $5, 'invited', now(), now())`,
            [accountId, publicId, invitation.invitee_email, preparedPasswordHash, displayName]
          );
          account = {
            display_name: displayName,
            id: accountId,
            password_hash: preparedPasswordHash,
            public_id: publicId,
            status: "invited"
          };
        }
        await client.query(
          `insert into profiles (user_id, public_profile_json)
           values ($1, jsonb_build_object('characterId', $2::text))
           on conflict (user_id) do update
           set public_profile_json = profiles.public_profile_json || excluded.public_profile_json,
               updated_at = now()`,
          [account.id, character.id]
        );
      }

      if (!account) {
        throw new BadRequestException("Invitation account could not be prepared.");
      }

      const activeMembership = await client.query<{ status: string }>(
        `select status from organization_memberships where organization_id = $1 and user_id = $2 for update`,
        [invitation.organization_id, account.id]
      );
      if (activeMembership.rows[0]?.status === "active") {
        throw new ConflictException("This account is already an active member.");
      }
      await client.query(
        `insert into organization_memberships (organization_id, user_id, role, status)
         values ($1, $2, $3, 'pending')
         on conflict (organization_id, user_id) do update
         set role = excluded.role, status = 'pending', joined_at = null`,
        [invitation.organization_id, account.id, invitation.requested_role]
      );
      await client.query(
        `update invitations
         set invitee_user_id = $2, accepted_by = $2, invitee_decision = 'accepted', invitee_decided_at = now(),
             use_count = use_count + 1, token_digest = null, updated_at = now()
         where id = $1`,
        [invitation.id, account.id]
      );

      const evidence = {
        client: "hahatalk-web-v1",
        source: "membership_invitation",
        userAgent: userAgent?.slice(0, 256) || "unknown"
      };
      await this.recordConsent(client, invitation, account.id, "terms", "granted", termsPolicyVersion, evidence);
      await this.recordConsent(client, invitation, account.id, "privacy", "granted", privacyPolicyVersion, evidence);
      await this.recordConsent(client, invitation, account.id, "group_join", "granted", groupJoinPolicyVersion, evidence);
      await this.writeAudit(client, invitation.organization_id, account.id, "invitation.invitee_accepted", invitation.id, {
        requestedRole: invitation.requested_role
      });

      const activated = await this.activateIfReady(client, invitation.id);
      return {
        email: invitation.invitee_email,
        loginAllowed: activated,
        role: invitation.requested_role,
        status: activated ? "accepted" : "pending_approval"
      };
    });
  }

  async decline(inviteCode: string) {
    if (await this.expireByCode(inviteCode)) {
      throw new GoneException("Invitation has expired.");
    }
    return this.database.transaction(async (client) => {
      const invitation = await this.invitationByCode(client, inviteCode);
      await this.assertCodeUsable(client, invitation);
      await client.query(
        `update invitations
         set status = 'declined', invitee_decision = 'declined', invitee_decided_at = now(),
             use_count = use_count + 1, token_digest = null, updated_at = now()
         where id = $1`,
        [invitation.id]
      );
      await this.recordConsent(client, invitation, invitation.invitee_user_id, "group_join", "denied", groupJoinPolicyVersion, {
        client: "hahatalk-web-v1",
        source: "membership_invitation"
      });
      await this.writeAudit(client, invitation.organization_id, invitation.invitee_user_id, "invitation.invitee_declined", invitation.id, {});
      return { ok: true, status: "declined" as const };
    });
  }

  async decide(
    principal: AuthPrincipal,
    invitationId: string,
    decision: InvitationDecision,
    note?: string
  ): Promise<MembershipInvitationView> {
    if (await this.expireById(invitationId)) {
      throw new GoneException("Invitation has expired.");
    }
    return this.database.transaction(async (client) => {
      const invitation = await this.invitationById(client, invitationId);
      this.assertSameOrganization(principal, invitation);
      await this.assertNotExpired(client, invitation);
      if (!activeInvitationStatuses.has(invitation.status)) {
        throw new ConflictException("This invitation no longer accepts approval decisions.");
      }

      const requirement = await client.query(
        `select 1 from invitation_approval_requirements
         where invitation_id = $1 and approver_id = $2`,
        [invitation.id, principal.internalUserId]
      );
      if (!requirement.rowCount) {
        throw new ForbiddenException("You are not a required approver for this invitation.");
      }
      const existing = await client.query(
        `select 1 from invitation_approvals where invitation_id = $1 and approver_id = $2`,
        [invitation.id, principal.internalUserId]
      );
      if (existing.rowCount) {
        throw new ConflictException("Your approval decision is already recorded.");
      }
      const progressBefore = await this.approvalProgress(client, invitation.id);
      if (progressBefore.approved >= invitation.required_approval_count) {
        throw new ConflictException("The required approval threshold is already complete.");
      }

      await client.query(
        `insert into invitation_approvals (invitation_id, approver_id, decision, note)
         values ($1, $2, $3, $4)`,
        [invitation.id, principal.internalUserId, decision, note?.trim() || null]
      );
      await this.writeAudit(client, invitation.organization_id, principal.internalUserId, `invitation.${decision}`, invitation.id, {
        policy: invitation.approval_policy
      });

      if (decision === "rejected") {
        const progress = await this.approvalProgress(client, invitation.id);
        if (progress.eligible - progress.rejected < invitation.required_approval_count) {
          await client.query(
            `update invitations set status = 'declined', token_digest = null, updated_at = now() where id = $1`,
            [invitation.id]
          );
          await this.deactivatePendingMembership(client, invitation);
        } else {
          await client.query(
            "update invitations set status = 'pending_approval', updated_at = now() where id = $1",
            [invitation.id]
          );
        }
      } else {
        const activated = await this.activateIfReady(client, invitation.id);
        if (!activated) {
          const approvedCount = await this.approvedCount(client, invitation.id);
          const nextStatus: InvitationStatus = approvedCount >= invitation.required_approval_count && !invitation.invitee_decision
            ? "sent"
            : "pending_approval";
          await client.query("update invitations set status = $2, updated_at = now() where id = $1", [invitation.id, nextStatus]);
        }
      }

      return this.viewById(client, invitation.id, principal);
    });
  }

  async revoke(principal: AuthPrincipal, invitationId: string): Promise<MembershipInvitationView> {
    if (await this.expireById(invitationId)) {
      throw new GoneException("Invitation has expired.");
    }
    return this.database.transaction(async (client) => {
      const invitation = await this.invitationById(client, invitationId);
      this.assertSameOrganization(principal, invitation);
      const canRevoke = principal.state.permissions.canInviteGuests && (
        principal.state.role === "owner"
        || (principal.state.role === "admin" && invitation.invited_by === principal.internalUserId)
      );
      if (!canRevoke) {
        throw new ForbiddenException("Invitation revoke permission is required.");
      }
      if (!activeInvitationStatuses.has(invitation.status)) {
        throw new ConflictException("Only an active invitation can be revoked.");
      }
      await client.query(
        `update invitations
         set status = 'revoked', token_digest = null, revoked_at = now(), revoked_by = $2,
             revoke_reason = 'manager_revoked', updated_at = now()
         where id = $1`,
        [invitation.id, principal.internalUserId]
      );
      await this.deactivatePendingMembership(client, invitation);
      await this.writeAudit(client, invitation.organization_id, principal.internalUserId, "invitation.revoked", invitation.id, {});
      return this.viewById(client, invitation.id, principal);
    });
  }

  private async selectApprovers(client: PoolClient, organizationId: string, policy: ApprovalPolicy) {
    const result = await client.query<ApproverRow>(
      `select om.user_id as internal_user_id, om.role
       from organization_memberships om
       where om.organization_id = $1 and om.status = 'active' and om.role <> 'guest'
       order by case om.role when 'owner' then 0 when 'admin' then 1 else 2 end, om.created_at asc`,
      [organizationId]
    );
    if (policy === "owner_and_invitee") {
      return result.rows.filter((row) => row.role === "owner");
    }
    if (policy === "admins_and_invitee") {
      return result.rows.filter((row) => row.role === "owner" || row.role === "admin");
    }
    return result.rows;
  }

  private async assertManagerMembership(client: PoolClient, principal: AuthPrincipal) {
    const result = await client.query<{ role: MemberRole; status: string }>(
      `select role, status from organization_memberships
       where organization_id = $1 and user_id = $2`,
      [principal.state.user.organizationId, principal.internalUserId]
    );
    const membership = result.rows[0];
    if (!membership || membership.status !== "active" || !["owner", "admin"].includes(membership.role)) {
      throw new ForbiddenException("Active manager membership is required.");
    }
  }

  private async invitationByCode(client: PoolClient, inviteCode: string) {
    const result = await client.query<InvitationRow>(
      "select * from invitations where token_digest = $1 for update",
      [inviteDigest(inviteCode)]
    );
    if (!result.rows[0]) {
      throw new NotFoundException("Invitation code is invalid or unavailable.");
    }
    return result.rows[0];
  }

  private async invitationById(client: PoolClient, invitationId: string) {
    const result = await client.query<InvitationRow>("select * from invitations where id = $1 for update", [invitationId]);
    if (!result.rows[0]) {
      throw new NotFoundException("Invitation was not found.");
    }
    return result.rows[0];
  }

  private async assertCodeUsable(client: PoolClient, invitation: InvitationRow) {
    await this.assertNotExpired(client, invitation);
    if (!activeInvitationStatuses.has(invitation.status) || invitation.use_count >= invitation.max_uses) {
      throw new GoneException("Invitation code is no longer available.");
    }
  }

  private async assertNotExpired(_client: PoolClient, invitation: InvitationRow) {
    if (invitation.expires_at.getTime() > Date.now()) {
      return;
    }
    throw new GoneException("Invitation has expired.");
  }

  private assertSameOrganization(principal: AuthPrincipal, invitation: InvitationRow) {
    if (invitation.organization_id !== principal.state.user.organizationId) {
      throw new NotFoundException("Invitation was not found.");
    }
  }

  private async approvedCount(client: PoolClient, invitationId: string) {
    const result = await client.query<{ count: number }>(
      `select count(*)::int as count from invitation_approvals
       where invitation_id = $1 and decision = 'approved'`,
      [invitationId]
    );
    return result.rows[0]?.count ?? 0;
  }

  private async approvalProgress(client: PoolClient, invitationId: string) {
    const result = await client.query<{ approved: number; eligible: number; rejected: number }>(
      `select
         (select count(*)::int from invitation_approval_requirements where invitation_id = $1) as eligible,
         (select count(*)::int from invitation_approvals where invitation_id = $1 and decision = 'approved') as approved,
         (select count(*)::int from invitation_approvals where invitation_id = $1 and decision = 'rejected') as rejected`,
      [invitationId]
    );
    return result.rows[0] ?? { approved: 0, eligible: 0, rejected: 0 };
  }

  private async activateIfReady(client: PoolClient, invitationId: string) {
    const result = await client.query<InvitationRow>("select * from invitations where id = $1 for update", [invitationId]);
    const invitation = result.rows[0]!;
    const approvedCount = await this.approvedCount(client, invitation.id);
    if (invitation.invitee_decision !== "accepted" || !invitation.invitee_user_id || approvedCount < invitation.required_approval_count) {
      await client.query(
        "update invitations set status = 'pending_approval', updated_at = now() where id = $1",
        [invitation.id]
      );
      return false;
    }

    await client.query(
      `update organization_memberships
       set status = 'active', joined_at = coalesce(joined_at, now())
       where organization_id = $1 and user_id = $2`,
      [invitation.organization_id, invitation.invitee_user_id]
    );
    await client.query(
      "update users set status = 'active', updated_at = now() where id = $1",
      [invitation.invitee_user_id]
    );
    await client.query(
      `update invitations set status = 'accepted', activated_at = now(), updated_at = now() where id = $1`,
      [invitation.id]
    );
    await this.writeAudit(client, invitation.organization_id, invitation.invitee_user_id, "membership.activated", invitation.id, {
      requestedRole: invitation.requested_role
    });
    return true;
  }

  private async deactivatePendingMembership(client: PoolClient, invitation: InvitationRow) {
    if (!invitation.invitee_user_id) {
      return;
    }
    await client.query(
      `update organization_memberships
       set status = 'left', joined_at = null
       where organization_id = $1 and user_id = $2 and status = 'pending'`,
      [invitation.organization_id, invitation.invitee_user_id]
    );
  }

  private async expireInvitations(client: PoolClient, organizationId: string) {
    const expired = await client.query<{ id: string }>(
      `update invitations
       set status = 'expired', token_digest = null, updated_at = now()
       where organization_id = $1 and status in ('pending_approval', 'sent') and expires_at <= now()
       returning id`,
      [organizationId]
    );
    for (const row of expired.rows) {
      await this.writeAudit(client, organizationId, null, "invitation.expired", row.id, {});
    }
  }

  private expireByCode(inviteCode: string) {
    return this.database.transaction(async (client) => {
      const expired = await client.query<{ id: string; organization_id: string }>(
        `update invitations
         set status = 'expired', token_digest = null, updated_at = now()
         where token_digest = $1 and status in ('pending_approval', 'sent') and expires_at <= now()
         returning id, organization_id`,
        [inviteDigest(inviteCode)]
      );
      for (const row of expired.rows) {
        await this.writeAudit(client, row.organization_id, null, "invitation.expired", row.id, {});
      }
      return Boolean(expired.rowCount);
    });
  }

  private expireById(invitationId: string) {
    return this.database.transaction(async (client) => {
      const expired = await client.query<{ id: string; organization_id: string }>(
        `update invitations
         set status = 'expired', token_digest = null, updated_at = now()
         where id = $1 and status in ('pending_approval', 'sent') and expires_at <= now()
         returning id, organization_id`,
        [invitationId]
      );
      for (const row of expired.rows) {
        await this.writeAudit(client, row.organization_id, null, "invitation.expired", row.id, {});
      }
      return Boolean(expired.rowCount);
    });
  }

  private async recordConsent(
    client: PoolClient,
    invitation: InvitationRow,
    subjectUserId: string | null,
    consentType: "terms" | "privacy" | "group_join",
    decision: "granted" | "denied",
    policyVersion: string,
    evidence: Record<string, string>
  ) {
    await client.query(
      `insert into consent_records (
         organization_id, subject_user_id, subject_email, invitation_id,
         consent_type, decision, policy_version, evidence_json
       ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        invitation.organization_id,
        subjectUserId,
        invitation.invitee_email,
        invitation.id,
        consentType,
        decision,
        policyVersion,
        JSON.stringify(evidence)
      ]
    );
  }

  private async viewById(client: PoolClient, invitationId: string, principal: AuthPrincipal) {
    const result = await client.query<InvitationViewRow>(
      `select
         i.*,
         inviter.display_name as inviter_display_name,
         o.name as organization_name,
         (select count(*)::int from invitation_approvals ia
           where ia.invitation_id = i.id and ia.decision = 'approved') as approved_count,
         exists(select 1 from invitation_approval_requirements iar
           where iar.invitation_id = i.id and iar.approver_id = $2) as required_for_current,
         (select ia.decision from invitation_approvals ia
           where ia.invitation_id = i.id and ia.approver_id = $2) as my_decision
       from invitations i
       join users inviter on inviter.id = i.invited_by
       join organizations o on o.id = i.organization_id
       where i.id = $1`,
      [invitationId, principal.internalUserId]
    );
    return this.toView(result.rows[0]!, principal);
  }

  private toView(row: InvitationViewRow, principal: AuthPrincipal): MembershipInvitationView {
    const canManage = principal.state.permissions.canInviteGuests && (
      principal.state.role === "owner"
      || (principal.state.role === "admin" && row.invited_by === principal.internalUserId)
    );
    const canDecide = row.required_for_current
      && !row.my_decision
      && activeInvitationStatuses.has(row.status)
      && row.approved_count < row.required_approval_count;
    return {
      canDecide,
      canManage,
      createdAt: row.created_at.toISOString(),
      email: row.invitee_email,
      expiresAt: row.expires_at.toISOString(),
      id: row.id,
      inviterDisplayName: row.inviter_display_name,
      role: row.requested_role,
      status: row.status,
      ...(row.invitee_decided_at && row.invitee_decision === "accepted"
        ? { inviteeAcceptedAt: row.invitee_decided_at.toISOString() }
        : {}),
      ...(row.my_decision ? { myDecision: row.my_decision } : {}),
      ...(canManage
        ? {
            approvalPolicy: row.approval_policy,
            approvedCount: row.approved_count,
            requiredApprovalCount: row.required_approval_count
          }
        : {})
    };
  }

  private writeAudit(
    client: PoolClient,
    organizationId: string,
    actorId: string | null,
    action: string,
    targetId: string,
    metadata: Record<string, string | number>
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, 'membership_invitation', $4, $5::jsonb)`,
      [organizationId, actorId, action, targetId, JSON.stringify(metadata)]
    );
  }
}
