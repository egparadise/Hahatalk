import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  findCharacterPreset,
  type ContactCollectionKind,
  type ContactCollectionView,
  type ContactCollectionVisibility,
  type ContactConsentDecision,
  type ContactConsentRequest,
  type ContactConsentResult,
  type ContactFollowUpState,
  type ContactPerson,
  type ContactRosterVisibility,
  type ContactsDashboard,
  type MemberRole
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";

type CreateCollectionInput = {
  name: string;
  description?: string;
  kind: ContactCollectionKind;
};

type UpdateCollectionInput = {
  name?: string;
  description?: string;
};

type MemberDetailsInput = {
  label?: string;
  notes?: string;
  tags?: string[];
  followUpState?: ContactFollowUpState;
  followUpAt?: string | null;
  sortOrder?: number;
};

type AddMemberInput = MemberDetailsInput & { userId: string };

type CollectionRow = {
  created_at: Date;
  description: string;
  id: string;
  kind: ContactCollectionKind;
  name: string;
  organization_id: string;
  owner_character_id: string | null;
  owner_display_name: string;
  owner_email: string;
  owner_id: string;
  owner_public_id: string;
  owner_role: MemberRole;
  policy_version: number;
  roster_visibility: ContactRosterVisibility;
  updated_at: Date;
  visibility: ContactCollectionVisibility;
};

type PersonRow = {
  added_at?: Date;
  character_id: string | null;
  display_name: string;
  email: string;
  internal_user_id: string;
  public_id: string;
  role: MemberRole;
};

type OwnerMemberRow = PersonRow & {
  consent_decision: ContactConsentDecision | null;
  follow_up_at: Date | null;
  follow_up_state: ContactFollowUpState;
  private_label: string;
  relationship_notes: string;
  sort_order: number;
  tags: string[];
};

type ConsentRequestRow = CollectionRow & {
  consent_decision: ContactConsentDecision | null;
  policy_created_at: Date;
  policy_json: Record<string, unknown>;
};

type PolicyInput = {
  rosterVisibility: ContactRosterVisibility;
  visibility: ContactCollectionVisibility;
};

const sharedKinds = new Set<ContactCollectionKind>(["family", "team"]);
const defaultSharedFields = [
  "collection_name",
  "collection_description",
  "owner_profile",
  "consenting_member_profiles"
];

function isUniqueViolation(error: unknown): error is { code: string } {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

@Injectable()
export class ContactsService {
  constructor(private readonly database: DatabaseService) {}

  dashboard(principal: AuthPrincipal): Promise<ContactsDashboard> {
    return this.database.transaction(async (client) => {
      const role = await this.activeRole(client, principal);
      const canManage = role !== "guest" && role !== "subscriber";
      const ownedRows = canManage
        ? (await client.query<CollectionRow>(
            `${this.collectionSelect()}
             where c.organization_id = $1 and c.owner_id = $2 and c.archived_at is null
             order by c.updated_at desc, c.created_at desc`,
            [principal.state.user.organizationId, principal.internalUserId]
          )).rows
        : [];
      const ownedCollections: ContactCollectionView[] = [];
      for (const row of ownedRows) {
        ownedCollections.push(await this.ownerView(client, row));
      }

      const sharedRows = await client.query<CollectionRow>(
        `${this.collectionSelect()}
         join contact_collection_members viewer_member
           on viewer_member.collection_id = c.id
          and viewer_member.user_id = $2
          and viewer_member.status = 'active'
         join organization_memberships viewer_membership
           on viewer_membership.organization_id = c.organization_id
          and viewer_membership.user_id = viewer_member.user_id
          and viewer_membership.status = 'active'
         join lateral (
           select consent.decision
           from contact_collection_consents consent
           where consent.collection_id = c.id
             and consent.user_id = viewer_member.user_id
             and consent.policy_version = c.policy_version
             and consent.decided_at >= viewer_member.added_at
           order by consent.decided_at desc, consent.id desc
           limit 1
         ) current_consent on current_consent.decision = 'granted'
         where c.organization_id = $1
           and c.owner_id <> $2
           and c.visibility = 'shared'
           and c.archived_at is null
         order by c.updated_at desc, c.created_at desc`,
        [principal.state.user.organizationId, principal.internalUserId]
      );
      const sharedCollections: ContactCollectionView[] = [];
      for (const row of sharedRows.rows) {
        sharedCollections.push(await this.sharedView(client, row, principal.internalUserId));
      }

      const requestRows = await client.query<ConsentRequestRow>(
        `select
           c.id, c.organization_id, c.owner_id, c.name, c.description, c.kind,
           c.visibility, c.roster_visibility, c.policy_version, c.created_at, c.updated_at,
           owner_user.public_id as owner_public_id,
           owner_user.email::text as owner_email,
           owner_user.display_name as owner_display_name,
           owner_membership.role as owner_role,
           owner_profile.public_profile_json ->> 'characterId' as owner_character_id,
           policy.policy_json,
           greatest(policy.created_at, viewer_member.added_at) as policy_created_at,
           current_consent.decision as consent_decision
         from contact_collections c
         join users owner_user on owner_user.id = c.owner_id
         join organization_memberships owner_membership
           on owner_membership.organization_id = c.organization_id
          and owner_membership.user_id = c.owner_id
          and owner_membership.status = 'active'
         left join profiles owner_profile on owner_profile.user_id = owner_user.id
         join contact_collection_members viewer_member
           on viewer_member.collection_id = c.id
          and viewer_member.user_id = $2
          and viewer_member.status = 'active'
         join organization_memberships viewer_membership
           on viewer_membership.organization_id = c.organization_id
          and viewer_membership.user_id = viewer_member.user_id
          and viewer_membership.status = 'active'
         join contact_collection_policies policy
           on policy.collection_id = c.id and policy.version = c.policy_version
         left join lateral (
           select consent.decision
           from contact_collection_consents consent
           where consent.collection_id = c.id
             and consent.user_id = viewer_member.user_id
             and consent.policy_version = c.policy_version
             and consent.decided_at >= viewer_member.added_at
           order by consent.decided_at desc, consent.id desc
           limit 1
         ) current_consent on true
         where c.organization_id = $1
           and c.owner_id <> $2
           and c.visibility = 'shared'
           and c.archived_at is null
           and current_consent.decision is distinct from 'granted'
         order by greatest(policy.created_at, viewer_member.added_at) desc`,
        [principal.state.user.organizationId, principal.internalUserId]
      );
      const consentRequests = requestRows.rows.map((row) => this.consentRequest(row));
      const availablePeople = canManage
        ? await this.availablePeople(client, principal.state.user.organizationId, principal.internalUserId)
        : [];

      return { availablePeople, canManage, consentRequests, ownedCollections, sharedCollections };
    });
  }

  async create(principal: AuthPrincipal, input: CreateCollectionInput): Promise<ContactCollectionView> {
    try {
      return await this.database.transaction(async (client) => {
        await this.assertCanManage(client, principal);
        const name = this.collectionName(input.name);
        const description = input.description?.trim() ?? "";
        const inserted = await client.query<{ id: string }>(
          `insert into contact_collections (organization_id, owner_id, name, description, kind)
           values ($1, $2, $3, $4, $5)
           returning id`,
          [principal.state.user.organizationId, principal.internalUserId, name, description, input.kind]
        );
        const collectionId = inserted.rows[0]!.id;
        await client.query(
          `insert into contact_collection_policies (
             collection_id, version, visibility, roster_visibility, policy_json, changed_by
           ) values ($1, 1, 'owner_only', 'shared', $2::jsonb, $3)`,
          [
            collectionId,
            JSON.stringify(this.policyJson(name, description, input.kind, "owner_only", "shared")),
            principal.internalUserId
          ]
        );
        await this.writeAudit(client, principal, "contact_collection.created", collectionId, {
          kind: input.kind,
          visibility: "owner_only"
        });
        return this.ownerView(client, await this.ownerCollection(client, principal, collectionId, false));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("An active contact collection already uses this name.");
      }
      throw error;
    }
  }

  async update(
    principal: AuthPrincipal,
    collectionId: string,
    input: UpdateCollectionInput
  ): Promise<ContactCollectionView> {
    if (input.name === undefined && input.description === undefined) {
      throw new BadRequestException("At least one collection field is required.");
    }
    try {
      return await this.database.transaction(async (client) => {
        await this.assertCanManage(client, principal);
        const current = await this.ownerCollection(client, principal, collectionId, true);
        const name = input.name === undefined ? current.name : this.collectionName(input.name);
        const description = input.description === undefined ? current.description : input.description.trim();
        const changed = name !== current.name || description !== current.description;
        if (!changed) {
          return this.ownerView(client, current);
        }
        const policyVersion = current.visibility === "shared" ? current.policy_version + 1 : current.policy_version;
        await client.query(
          `update contact_collections
           set name = $2, description = $3, policy_version = $4, updated_at = now()
           where id = $1`,
          [collectionId, name, description, policyVersion]
        );
        if (current.visibility === "shared") {
          await this.insertPolicy(
            client,
            collectionId,
            policyVersion,
            current.visibility,
            current.roster_visibility,
            name,
            description,
            current.kind,
            principal.internalUserId
          );
        }
        await this.writeAudit(client, principal, "contact_collection.updated", collectionId, {
          policyVersion,
          consentReset: current.visibility === "shared" ? 1 : 0
        });
        return this.ownerView(client, await this.ownerCollection(client, principal, collectionId, false));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("An active contact collection already uses this name.");
      }
      throw error;
    }
  }

  archive(principal: AuthPrincipal, collectionId: string) {
    return this.database.transaction(async (client) => {
      await this.assertCanManage(client, principal);
      await this.ownerCollection(client, principal, collectionId, true);
      const archived = await client.query<{ archived_at: Date }>(
        `update contact_collections
         set archived_at = now(), updated_at = now()
         where id = $1
         returning archived_at`,
        [collectionId]
      );
      await this.writeAudit(client, principal, "contact_collection.archived", collectionId, {});
      return { archivedAt: archived.rows[0]!.archived_at.toISOString(), id: collectionId };
    });
  }

  addMember(principal: AuthPrincipal, collectionId: string, input: AddMemberInput): Promise<ContactCollectionView> {
    return this.database.transaction(async (client) => {
      await this.assertCanManage(client, principal);
      const collection = await this.ownerCollection(client, principal, collectionId, true);
      const target = await this.organizationPerson(client, principal.state.user.organizationId, input.userId);
      if (target.internal_user_id === principal.internalUserId) {
        throw new BadRequestException("The collection owner is already included implicitly.");
      }
      const existing = await client.query<{ status: "active" | "removed" }>(
        `select status from contact_collection_members
         where collection_id = $1 and user_id = $2
         for update`,
        [collectionId, target.internal_user_id]
      );
      if (existing.rows[0]?.status === "active") {
        throw new ConflictException("This person is already in the collection.");
      }
      const values = this.memberValues(input);
      await client.query(
        `insert into contact_collection_members (
           collection_id, user_id, added_by, private_label, relationship_notes,
           follow_up_state, follow_up_at, sort_order
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (collection_id, user_id) do update
         set added_by = excluded.added_by,
             private_label = excluded.private_label,
             relationship_notes = excluded.relationship_notes,
             follow_up_state = excluded.follow_up_state,
             follow_up_at = excluded.follow_up_at,
             sort_order = excluded.sort_order,
             status = 'active',
             added_at = now(),
             updated_at = now(),
             removed_at = null`,
        [
          collectionId,
          target.internal_user_id,
          principal.internalUserId,
          values.label,
          values.notes,
          values.followUpState,
          values.followUpAt,
          values.sortOrder
        ]
      );
      await this.replaceTags(client, collectionId, target.internal_user_id, values.tags);
      await this.touchCollection(client, collectionId);
      await this.writeAudit(client, principal, "contact_collection.member_added", collectionId, {
        memberPublicId: target.public_id,
        policyVersion: collection.policy_version
      });
      return this.ownerView(client, await this.ownerCollection(client, principal, collectionId, false));
    });
  }

  updateMember(
    principal: AuthPrincipal,
    collectionId: string,
    publicUserId: string,
    input: MemberDetailsInput
  ): Promise<ContactCollectionView> {
    const hasChange = input.label !== undefined
      || input.notes !== undefined
      || input.tags !== undefined
      || input.followUpState !== undefined
      || input.followUpAt !== undefined
      || input.sortOrder !== undefined;
    if (!hasChange) {
      throw new BadRequestException("At least one member field is required.");
    }
    return this.database.transaction(async (client) => {
      await this.assertCanManage(client, principal);
      await this.ownerCollection(client, principal, collectionId, true);
      const member = await this.activeCollectionMember(client, collectionId, publicUserId, true);
      const changedFields: string[] = [];
      const hasLabel = input.label !== undefined;
      const hasNotes = input.notes !== undefined;
      const hasFollowUpState = input.followUpState !== undefined;
      const hasFollowUpAt = input.followUpAt !== undefined;
      const hasSortOrder = input.sortOrder !== undefined;
      if (hasLabel) changedFields.push("label");
      if (hasNotes) changedFields.push("notes");
      if (input.tags !== undefined) changedFields.push("tags");
      if (hasFollowUpState) changedFields.push("followUpState");
      if (hasFollowUpAt) changedFields.push("followUpAt");
      if (hasSortOrder) changedFields.push("sortOrder");
      await client.query(
        `update contact_collection_members
         set private_label = case when $3::boolean then $4 else private_label end,
             relationship_notes = case when $5::boolean then $6 else relationship_notes end,
             follow_up_state = case when $7::boolean then $8 else follow_up_state end,
             follow_up_at = case when $9::boolean then $10::timestamptz else follow_up_at end,
             sort_order = case when $11::boolean then $12 else sort_order end,
             updated_at = now()
         where collection_id = $1 and user_id = $2 and status = 'active'`,
        [
          collectionId,
          member.internal_user_id,
          hasLabel,
          input.label?.trim() ?? "",
          hasNotes,
          input.notes?.trim() ?? "",
          hasFollowUpState,
          input.followUpState ?? "none",
          hasFollowUpAt,
          input.followUpAt ?? null,
          hasSortOrder,
          input.sortOrder ?? 0
        ]
      );
      if (input.tags !== undefined) {
        await this.replaceTags(client, collectionId, member.internal_user_id, this.normalizeTags(input.tags));
      }
      await this.touchCollection(client, collectionId);
      await this.writeAudit(client, principal, "contact_collection.member_updated", collectionId, {
        changedFields: changedFields.join(","),
        memberPublicId: member.public_id
      });
      return this.ownerView(client, await this.ownerCollection(client, principal, collectionId, false));
    });
  }

  removeMember(principal: AuthPrincipal, collectionId: string, publicUserId: string): Promise<ContactCollectionView> {
    return this.database.transaction(async (client) => {
      await this.assertCanManage(client, principal);
      await this.ownerCollection(client, principal, collectionId, true);
      const member = await this.activeCollectionMember(client, collectionId, publicUserId, true);
      await client.query(
        `update contact_collection_members
         set status = 'removed', removed_at = now(), updated_at = now()
         where collection_id = $1 and user_id = $2 and status = 'active'`,
        [collectionId, member.internal_user_id]
      );
      await this.touchCollection(client, collectionId);
      await this.writeAudit(client, principal, "contact_collection.member_removed", collectionId, {
        memberPublicId: member.public_id
      });
      return this.ownerView(client, await this.ownerCollection(client, principal, collectionId, false));
    });
  }

  setPolicy(principal: AuthPrincipal, collectionId: string, input: PolicyInput): Promise<ContactCollectionView> {
    return this.database.transaction(async (client) => {
      await this.assertCanManage(client, principal);
      const current = await this.ownerCollection(client, principal, collectionId, true);
      if (input.visibility === "shared" && !sharedKinds.has(current.kind)) {
        throw new BadRequestException("Only family and team collections can be shared in Stage 4.");
      }
      if (current.visibility === input.visibility && current.roster_visibility === input.rosterVisibility) {
        return this.ownerView(client, current);
      }
      const version = current.policy_version + 1;
      await client.query(
        `update contact_collections
         set visibility = $2, roster_visibility = $3, policy_version = $4, updated_at = now()
         where id = $1`,
        [collectionId, input.visibility, input.rosterVisibility, version]
      );
      await this.insertPolicy(
        client,
        collectionId,
        version,
        input.visibility,
        input.rosterVisibility,
        current.name,
        current.description,
        current.kind,
        principal.internalUserId
      );
      await this.writeAudit(client, principal, "contact_collection.policy_changed", collectionId, {
        policyVersion: version,
        rosterVisibility: input.rosterVisibility,
        visibility: input.visibility
      });
      return this.ownerView(client, await this.ownerCollection(client, principal, collectionId, false));
    });
  }

  consent(
    principal: AuthPrincipal,
    collectionId: string,
    policyVersion: number,
    decision: ContactConsentDecision,
    clientId?: string
  ): Promise<ContactConsentResult> {
    return this.database.transaction(async (client) => {
      await this.activeRole(client, principal);
      const result = await client.query<{
        policy_version: number;
      }>(
        `select c.policy_version
         from contact_collections c
         join contact_collection_members member
           on member.collection_id = c.id
          and member.user_id = $3
          and member.status = 'active'
         where c.id = $1
           and c.organization_id = $2
           and c.owner_id <> $3
           and c.visibility = 'shared'
           and c.archived_at is null
         for update of c, member`,
        [collectionId, principal.state.user.organizationId, principal.internalUserId]
      );
      const collection = result.rows[0];
      if (!collection) {
        throw new NotFoundException("Contact consent request was not found.");
      }
      if (collection.policy_version !== policyVersion) {
        throw new ConflictException("The contact sharing policy changed. Refresh before deciding.");
      }
      const inserted = await client.query<{ decided_at: Date }>(
        `insert into contact_collection_consents (
           collection_id, user_id, policy_version, decision, evidence_json
         ) values ($1, $2, $3, $4, $5::jsonb)
         returning decided_at`,
        [
          collectionId,
          principal.internalUserId,
          policyVersion,
          decision,
          JSON.stringify({ client: clientId?.slice(0, 80) || "unknown", method: "explicit_action" })
        ]
      );
      const decidedAt = inserted.rows[0]!.decided_at.toISOString();
      await this.writeAudit(client, principal, `contact_collection.consent_${decision}`, collectionId, {
        policyVersion
      });
      return { collectionId, decidedAt, decision, policyVersion };
    });
  }

  private collectionSelect() {
    return `select
      c.id, c.organization_id, c.owner_id, c.name, c.description, c.kind,
      c.visibility, c.roster_visibility, c.policy_version, c.created_at, c.updated_at,
      owner_user.public_id as owner_public_id,
      owner_user.email::text as owner_email,
      owner_user.display_name as owner_display_name,
      owner_membership.role as owner_role,
      owner_profile.public_profile_json ->> 'characterId' as owner_character_id
    from contact_collections c
    join users owner_user on owner_user.id = c.owner_id
    join organization_memberships owner_membership
      on owner_membership.organization_id = c.organization_id
     and owner_membership.user_id = c.owner_id
     and owner_membership.status = 'active'
    left join profiles owner_profile on owner_profile.user_id = owner_user.id`;
  }

  private async ownerCollection(
    client: PoolClient,
    principal: AuthPrincipal,
    collectionId: string,
    lock: boolean
  ) {
    const result = await client.query<CollectionRow>(
      `${this.collectionSelect()}
       where c.id = $1
         and c.organization_id = $2
         and c.owner_id = $3
         and c.archived_at is null
       ${lock ? "for update of c" : ""}`,
      [collectionId, principal.state.user.organizationId, principal.internalUserId]
    );
    if (!result.rows[0]) {
      throw new NotFoundException("Contact collection was not found.");
    }
    return result.rows[0];
  }

  private async ownerView(client: PoolClient, collection: CollectionRow): Promise<ContactCollectionView> {
    const result = await client.query<OwnerMemberRow>(
      `select
         member_user.id as internal_user_id,
         member_user.public_id,
         member_user.email::text,
         member_user.display_name,
         member_membership.role,
         member_profile.public_profile_json ->> 'characterId' as character_id,
         member.added_at,
         member.private_label,
         member.relationship_notes,
         member.follow_up_state,
         member.follow_up_at,
         member.sort_order,
         coalesce(array(
           select tag.tag from contact_member_tags tag
           where tag.collection_id = member.collection_id and tag.user_id = member.user_id
           order by tag.tag
         ), array[]::text[]) as tags,
         current_consent.decision as consent_decision
       from contact_collection_members member
       join users member_user on member_user.id = member.user_id and member_user.status = 'active'
       join organization_memberships member_membership
         on member_membership.organization_id = $2
        and member_membership.user_id = member.user_id
        and member_membership.status = 'active'
       left join profiles member_profile on member_profile.user_id = member_user.id
       left join lateral (
         select consent.decision
         from contact_collection_consents consent
         where consent.collection_id = member.collection_id
           and consent.user_id = member.user_id
           and consent.policy_version = $3
           and consent.decided_at >= member.added_at
         order by consent.decided_at desc, consent.id desc
         limit 1
       ) current_consent on true
       where member.collection_id = $1 and member.status = 'active'
       order by member.sort_order, member.added_at, member_user.display_name`,
      [collection.id, collection.organization_id, collection.policy_version]
    );
    return {
      createdAt: collection.created_at.toISOString(),
      description: collection.description,
      id: collection.id,
      isOwner: true,
      kind: collection.kind,
      members: result.rows.map((row) => ({
        addedAt: row.added_at!.toISOString(),
        ...(collection.visibility === "shared"
          ? { consentStatus: row.consent_decision ?? "pending" as const }
          : {}),
        person: this.person(row),
        privateDetails: {
          followUpState: row.follow_up_state,
          label: row.private_label,
          notes: row.relationship_notes,
          sortOrder: row.sort_order,
          tags: row.tags,
          ...(row.follow_up_at ? { followUpAt: row.follow_up_at.toISOString() } : {})
        }
      })),
      name: collection.name,
      owner: this.ownerPerson(collection),
      policyVersion: collection.policy_version,
      rosterVisibility: collection.roster_visibility,
      updatedAt: collection.updated_at.toISOString(),
      visibility: collection.visibility
    };
  }

  private async sharedView(
    client: PoolClient,
    collection: CollectionRow,
    viewerInternalId: string
  ): Promise<ContactCollectionView> {
    const result = await client.query<PersonRow>(
      `select
         member_user.id as internal_user_id,
         member_user.public_id,
         member_user.email::text,
         member_user.display_name,
         member_membership.role,
         member_profile.public_profile_json ->> 'characterId' as character_id,
         member.added_at
       from contact_collection_members member
       join users member_user on member_user.id = member.user_id and member_user.status = 'active'
       join organization_memberships member_membership
         on member_membership.organization_id = $2
        and member_membership.user_id = member.user_id
        and member_membership.status = 'active'
       left join profiles member_profile on member_profile.user_id = member_user.id
       left join lateral (
         select consent.decision
         from contact_collection_consents consent
         where consent.collection_id = member.collection_id
           and consent.user_id = member.user_id
           and consent.policy_version = $4
           and consent.decided_at >= member.added_at
         order by consent.decided_at desc, consent.id desc
         limit 1
       ) current_consent on true
       where member.collection_id = $1
         and member.status = 'active'
         and (
           member.user_id = $3
           or ($5::text = 'shared' and current_consent.decision = 'granted')
         )
       order by member.sort_order, member.added_at, member_user.display_name`,
      [
        collection.id,
        collection.organization_id,
        viewerInternalId,
        collection.policy_version,
        collection.roster_visibility
      ]
    );
    return {
      createdAt: collection.created_at.toISOString(),
      description: collection.description,
      id: collection.id,
      isOwner: false,
      kind: collection.kind,
      members: [
        { addedAt: collection.created_at.toISOString(), person: this.ownerPerson(collection) },
        ...result.rows.map((row) => ({ addedAt: row.added_at!.toISOString(), person: this.person(row) }))
      ],
      name: collection.name,
      owner: this.ownerPerson(collection),
      policyVersion: collection.policy_version,
      rosterVisibility: collection.roster_visibility,
      updatedAt: collection.updated_at.toISOString(),
      visibility: "shared"
    };
  }

  private consentRequest(row: ConsentRequestRow): ContactConsentRequest {
    const policyName = typeof row.policy_json.collectionName === "string"
      ? row.policy_json.collectionName
      : row.name;
    const policyDescription = typeof row.policy_json.collectionDescription === "string"
      ? row.policy_json.collectionDescription
      : row.description;
    const policyFields = Array.isArray(row.policy_json.sharedFields)
      ? row.policy_json.sharedFields.filter((value): value is string => typeof value === "string")
      : defaultSharedFields;
    return {
      collectionDescription: policyDescription,
      collectionId: row.id,
      collectionName: policyName,
      kind: row.kind as "family" | "team",
      ...(row.consent_decision ? { myDecision: row.consent_decision } : {}),
      owner: this.ownerPerson(row),
      policyVersion: row.policy_version,
      requestedAt: row.policy_created_at.toISOString(),
      rosterVisibility: row.roster_visibility,
      sharedFields: policyFields
    };
  }

  private async availablePeople(client: PoolClient, organizationId: string, viewerId: string) {
    const result = await client.query<PersonRow>(
      `select
         member_user.id as internal_user_id,
         member_user.public_id,
         member_user.email::text,
         member_user.display_name,
         membership.role,
         profile.public_profile_json ->> 'characterId' as character_id
       from organization_memberships membership
       join users member_user on member_user.id = membership.user_id and member_user.status = 'active'
       left join profiles profile on profile.user_id = member_user.id
       where membership.organization_id = $1
         and membership.status = 'active'
         and membership.user_id <> $2
         and coalesce(profile.public_profile_json ->> 'accountKind', '') <> 'local_ai'
       order by member_user.display_name, member_user.email`,
      [organizationId, viewerId]
    );
    return result.rows.map((row) => this.person(row));
  }

  private async organizationPerson(client: PoolClient, organizationId: string, publicUserId: string) {
    const result = await client.query<PersonRow>(
      `select
         member_user.id as internal_user_id,
         member_user.public_id,
         member_user.email::text,
         member_user.display_name,
         membership.role,
         profile.public_profile_json ->> 'characterId' as character_id
       from users member_user
       join organization_memberships membership
         on membership.user_id = member_user.id
        and membership.organization_id = $1
        and membership.status = 'active'
       left join profiles profile on profile.user_id = member_user.id
       where member_user.public_id = $2 and member_user.status = 'active'
         and coalesce(profile.public_profile_json ->> 'accountKind', '') <> 'local_ai'`,
      [organizationId, publicUserId]
    );
    if (!result.rows[0]) {
      throw new NotFoundException("Active organization member was not found.");
    }
    return result.rows[0];
  }

  private async activeCollectionMember(
    client: PoolClient,
    collectionId: string,
    publicUserId: string,
    lock: boolean
  ) {
    const result = await client.query<PersonRow>(
      `select
         member_user.id as internal_user_id,
         member_user.public_id,
         member_user.email::text,
         member_user.display_name,
         membership.role,
         profile.public_profile_json ->> 'characterId' as character_id,
         member.added_at
       from contact_collection_members member
       join users member_user on member_user.id = member.user_id
       join contact_collections collection on collection.id = member.collection_id
       join organization_memberships membership
         on membership.organization_id = collection.organization_id
        and membership.user_id = member.user_id
        and membership.status = 'active'
       left join profiles profile on profile.user_id = member_user.id
       where member.collection_id = $1
         and member_user.public_id = $2
         and member.status = 'active'
       ${lock ? "for update of member" : ""}`,
      [collectionId, publicUserId]
    );
    if (!result.rows[0]) {
      throw new NotFoundException("Contact member was not found.");
    }
    return result.rows[0];
  }

  private async activeRole(client: PoolClient, principal: AuthPrincipal) {
    const result = await client.query<{ role: MemberRole }>(
      `select membership.role
       from organization_memberships membership
       join users member_user on member_user.id = membership.user_id
       where membership.organization_id = $1
         and membership.user_id = $2
         and membership.status = 'active'
         and member_user.status = 'active'`,
      [principal.state.user.organizationId, principal.internalUserId]
    );
    const role = result.rows[0]?.role;
    if (!role) {
      throw new ForbiddenException("Active organization membership is required.");
    }
    return role;
  }

  private async assertCanManage(client: PoolClient, principal: AuthPrincipal) {
    const role = await this.activeRole(client, principal);
    if (role === "guest" || role === "subscriber") {
      throw new ForbiddenException("Contact collection management requires an internal membership.");
    }
  }

  private memberValues(input: MemberDetailsInput) {
    return {
      followUpAt: input.followUpAt ?? null,
      followUpState: input.followUpState ?? "none",
      label: input.label?.trim() ?? "",
      notes: input.notes?.trim() ?? "",
      sortOrder: input.sortOrder ?? 0,
      tags: this.normalizeTags(input.tags ?? [])
    };
  }

  private collectionName(value: string) {
    const name = value.trim();
    if (name.length === 0 || name.length > 80) {
      throw new BadRequestException("Collection name must contain between 1 and 80 characters.");
    }
    return name;
  }

  private normalizeTags(tags: string[]) {
    const normalized = [...new Set(tags.map((tag) => tag.trim().toLocaleLowerCase("ko-KR")))];
    if (normalized.some((tag) => tag.length === 0 || tag.length > 32)) {
      throw new BadRequestException("Tags must contain between 1 and 32 characters.");
    }
    return normalized.sort((left, right) => left.localeCompare(right, "ko-KR"));
  }

  private async replaceTags(client: PoolClient, collectionId: string, userId: string, tags: string[]) {
    await client.query(
      "delete from contact_member_tags where collection_id = $1 and user_id = $2",
      [collectionId, userId]
    );
    for (const tag of tags) {
      await client.query(
        `insert into contact_member_tags (collection_id, user_id, tag)
         values ($1, $2, $3)`,
        [collectionId, userId, tag]
      );
    }
  }

  private insertPolicy(
    client: PoolClient,
    collectionId: string,
    version: number,
    visibility: ContactCollectionVisibility,
    rosterVisibility: ContactRosterVisibility,
    name: string,
    description: string,
    kind: ContactCollectionKind,
    actorId: string
  ) {
    return client.query(
      `insert into contact_collection_policies (
         collection_id, version, visibility, roster_visibility, policy_json, changed_by
       ) values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        collectionId,
        version,
        visibility,
        rosterVisibility,
        JSON.stringify(this.policyJson(name, description, kind, visibility, rosterVisibility)),
        actorId
      ]
    );
  }

  private policyJson(
    name: string,
    description: string,
    kind: ContactCollectionKind,
    visibility: ContactCollectionVisibility,
    rosterVisibility: ContactRosterVisibility
  ) {
    return {
      collectionDescription: description,
      collectionName: name,
      kind,
      rosterVisibility,
      sharedFields: defaultSharedFields,
      visibility
    };
  }

  private touchCollection(client: PoolClient, collectionId: string) {
    return client.query("update contact_collections set updated_at = now() where id = $1", [collectionId]);
  }

  private ownerPerson(row: CollectionRow): ContactPerson {
    return {
      character: findCharacterPreset(row.owner_character_id ?? ""),
      displayName: row.owner_display_name,
      email: row.owner_email,
      id: row.owner_public_id,
      role: row.owner_role
    };
  }

  private person(row: PersonRow): ContactPerson {
    return {
      character: findCharacterPreset(row.character_id ?? ""),
      displayName: row.display_name,
      email: row.email,
      id: row.public_id,
      role: row.role
    };
  }

  private writeAudit(
    client: PoolClient,
    principal: AuthPrincipal,
    action: string,
    targetId: string,
    metadata: Record<string, string | number>
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, 'contact_collection', $4, $5::jsonb)`,
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
