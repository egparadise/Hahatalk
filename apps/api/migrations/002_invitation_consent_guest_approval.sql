alter table users
  add column bootstrap_claim_allowed boolean not null default false;

update users
set bootstrap_claim_allowed = true
where id in (
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102'
);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  invited_by uuid not null references users(id),
  invitee_user_id uuid references users(id),
  invitee_email citext not null,
  requested_role text not null check (requested_role in ('member', 'guest')),
  approval_policy text not null check (approval_policy in (
    'owner_and_invitee', 'admins_and_invitee', 'all_members_and_invitee', 'quorum_and_invitee'
  )),
  required_approval_count integer not null check (required_approval_count >= 1),
  status text not null check (status in (
    'pending_approval', 'sent', 'accepted', 'declined', 'expired', 'revoked'
  )),
  token_digest bytea unique,
  token_issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses integer not null default 1 check (max_uses = 1),
  use_count integer not null default 0 check (use_count between 0 and max_uses),
  invitee_decision text check (invitee_decision in ('accepted', 'declined')),
  invitee_decided_at timestamptz,
  accepted_by uuid references users(id),
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references users(id),
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > token_issued_at),
  check ((invitee_decision is null) = (invitee_decided_at is null))
);

create unique index invitations_one_open_email_idx
  on invitations(organization_id, lower(invitee_email::text))
  where status in ('pending_approval', 'sent');

create index invitations_org_created_idx
  on invitations(organization_id, created_at desc);

create index invitations_expiry_idx
  on invitations(expires_at)
  where status in ('pending_approval', 'sent');

create table invitation_approval_requirements (
  invitation_id uuid not null references invitations(id) on delete cascade,
  approver_id uuid not null references users(id),
  role_snapshot text not null check (role_snapshot in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (invitation_id, approver_id)
);

create index invitation_requirements_approver_idx
  on invitation_approval_requirements(approver_id, created_at desc);

create table invitation_approvals (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references invitations(id) on delete cascade,
  approver_id uuid not null references users(id),
  decision text not null check (decision in ('approved', 'rejected')),
  note text,
  decided_at timestamptz not null default now(),
  unique (invitation_id, approver_id)
);

create table consent_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  subject_user_id uuid references users(id),
  subject_email citext,
  invitation_id uuid references invitations(id) on delete set null,
  consent_type text not null check (consent_type in ('terms', 'privacy', 'group_join')),
  decision text not null check (decision in ('granted', 'denied', 'revoked', 'expired')),
  policy_version text not null,
  evidence_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (subject_user_id is not null or subject_email is not null)
);

create index consent_records_subject_idx
  on consent_records(subject_user_id, created_at desc);

create index consent_records_invitation_idx
  on consent_records(invitation_id, created_at asc);
