# Stage 4 Contacts, Family, And Managed Groups

## Scope

Stage 4 adds an owner-managed relationship desk without turning private address-book classification into a visible group. Contact collections remain separate from conversation spaces.

- `family`, `team`: owner-only or explicit-consent shared collection.
- `customers`, `service`, `custom`: owner-only in Stage 4.
- Guest members may receive and decide an explicit sharing request, but cannot create or manage collections.
- Any active internal owner/admin/member can own a separate private collection. Organization role never grants access to another owner's collection.

## Data Model

- `contact_collections`: organization, owner, kind, current visibility, roster rule, current policy version, archive state.
- `contact_collection_members`: soft membership period and owner-private label, notes, follow-up state/time, ordering.
- `contact_member_tags`: normalized owner-private tags.
- `contact_collection_policies`: immutable policy snapshots keyed by collection and integer version.
- `contact_collection_consents`: append-only grant, deny, and revoke decisions for an exact policy version.

The latest decision is effective only when all conditions hold:

1. The collection is active and currently shared.
2. The viewer is an active collection and organization member.
3. The decision targets the collection's current policy version.
4. The decision occurred after the current membership period began.
5. The latest matching decision is `granted`.

Condition 4 prevents a removed and re-added member from inheriting an old grant.

## Viewer Projections

The API does not serialize one owner DTO and remove fields afterward. It builds three separate projections.

### Owner

- All owned collections and active members.
- Private label, relationship notes, tags, follow-up state/time.
- Each member's effective current consent status.
- Active organization directory for adding members.

### Pending Member

- Explicitly shared collection name and description.
- Owner profile, collection kind, policy version, roster rule, shared-field list.
- No roster, member count, private metadata, or other consent decision.

### Consented Member

- Collection name/description and owner profile.
- Owner and self always.
- Other members only when roster policy is `shared` and those members granted the exact current version.
- No private labels, notes, tags, follow-up state, or other members' consent evidence.

An owner-only collection is absent from non-owner dashboard results and returns the same mutation error as a nonexistent collection.

## API

- `GET /contacts`
- `POST /contact-collections`
- `PATCH /contact-collections/:collectionId`
- `DELETE /contact-collections/:collectionId`
- `POST /contact-collections/:collectionId/members`
- `PATCH /contact-collections/:collectionId/members/:userId`
- `DELETE /contact-collections/:collectionId/members/:userId`
- `POST /contact-collections/:collectionId/policy`
- `POST /contact-collections/:collectionId/consent`

Every mutation writes an `audit_logs` event without copying private relationship content into audit metadata.

## Policy Changes

- Changing visibility or roster scope increments `policy_version` and appends a snapshot.
- Renaming or changing the description of a currently shared collection also increments the version because the disclosed data changed.
- Existing decisions remain historical evidence but no longer grant current access.
- Returning to owner-only removes pending and shared projections immediately.
- Sharing does not create a chat room or conversation membership.

## PC UX

The people rail button opens a four-column contacts desk:

1. Product rail.
2. Consent requests and owned/shared collection list with creation controls.
3. Consent disclosure or collection roster.
4. Collection settings, policy, member addition, private relationship editor, or consent controls.

The right management panel becomes an overlay on narrower PC windows. Loading, empty, error/retry, mutation busy, and success states are explicit.

## Verification

`npm run contacts:integration` creates a fresh PostgreSQL database and checks:

- owner-only ID/name/member/private metadata non-disclosure;
- generic hidden-resource errors;
- role-versus-owner authorization;
- restricted shareable kinds;
- exact-version consent and stale-version rejection;
- shared and owner-only roster projection;
- deny, revoke, re-grant, remove/re-add, and concurrent duplicate add;
- guest request and management restriction;
- append-only policy/consent history and audit metadata minimization;
- API restart persistence and archive removal.

The installed Electron renderer harness creates an invited guest, proves the guest cannot see an owner-only family collection, changes the policy, records consent, and verifies the owner-and-self roster without owner-private notes.
