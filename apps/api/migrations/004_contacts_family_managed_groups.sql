create table contact_collections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  name text not null,
  description text not null default '',
  kind text not null check (kind in ('family', 'team', 'customers', 'service', 'custom')),
  visibility text not null default 'owner_only' check (visibility in ('owner_only', 'shared')),
  roster_visibility text not null default 'shared' check (roster_visibility in ('shared', 'owner_only')),
  policy_version integer not null default 1 check (policy_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (char_length(btrim(name)) between 1 and 80),
  check (char_length(description) <= 500),
  check (visibility = 'owner_only' or kind in ('family', 'team'))
);

create unique index contact_collections_active_owner_name_idx
  on contact_collections(owner_id, lower(btrim(name)))
  where archived_at is null;

create index contact_collections_org_owner_idx
  on contact_collections(organization_id, owner_id, updated_at desc)
  where archived_at is null;

create table contact_collection_members (
  collection_id uuid not null references contact_collections(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  added_by uuid not null references users(id),
  private_label text not null default '',
  relationship_notes text not null default '',
  follow_up_state text not null default 'none' check (follow_up_state in ('none', 'planned', 'waiting', 'completed')),
  follow_up_at timestamptz,
  sort_order integer not null default 0,
  status text not null default 'active' check (status in ('active', 'removed')),
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (collection_id, user_id),
  check (char_length(private_label) <= 80),
  check (char_length(relationship_notes) <= 2000),
  check ((status = 'active' and removed_at is null) or (status = 'removed' and removed_at is not null))
);

create index contact_collection_members_user_active_idx
  on contact_collection_members(user_id, collection_id)
  where status = 'active';

create index contact_collection_members_follow_up_idx
  on contact_collection_members(collection_id, follow_up_at)
  where status = 'active' and follow_up_at is not null;

create table contact_member_tags (
  collection_id uuid not null,
  user_id uuid not null,
  tag text not null,
  created_at timestamptz not null default now(),
  primary key (collection_id, user_id, tag),
  foreign key (collection_id, user_id)
    references contact_collection_members(collection_id, user_id) on delete cascade,
  check (char_length(tag) between 1 and 32),
  check (tag = lower(btrim(tag)))
);

create table contact_collection_policies (
  collection_id uuid not null references contact_collections(id) on delete cascade,
  version integer not null check (version > 0),
  visibility text not null check (visibility in ('owner_only', 'shared')),
  roster_visibility text not null check (roster_visibility in ('shared', 'owner_only')),
  policy_json jsonb not null default '{}',
  changed_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (collection_id, version)
);

create table contact_collection_consents (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null,
  user_id uuid not null,
  policy_version integer not null check (policy_version > 0),
  decision text not null check (decision in ('granted', 'denied', 'revoked')),
  evidence_json jsonb not null default '{}',
  decided_at timestamptz not null default now(),
  foreign key (collection_id, user_id)
    references contact_collection_members(collection_id, user_id) on delete cascade,
  foreign key (collection_id, policy_version)
    references contact_collection_policies(collection_id, version) on delete cascade
);

create index contact_collection_consents_effective_idx
  on contact_collection_consents(collection_id, user_id, policy_version, decided_at desc, id desc);

create index contact_collection_consents_user_idx
  on contact_collection_consents(user_id, decided_at desc);
