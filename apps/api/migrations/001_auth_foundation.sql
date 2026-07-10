create extension if not exists pgcrypto;
create extension if not exists citext;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null check (plan in ('trial', 'business', 'enterprise')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  email citext not null unique,
  phone text unique,
  password_hash text,
  display_name text not null,
  status text not null check (status in ('invited', 'active', 'suspended', 'deleted')),
  locale text not null default 'ko-KR',
  timezone text not null default 'Asia/Seoul',
  auth_version integer not null default 1 check (auth_version > 0),
  account_claimed_at timestamptz,
  password_changed_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(public_id) between 3 and 80),
  check (char_length(display_name) between 2 and 80)
);

create table organization_memberships (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'guest')),
  status text not null check (status in ('pending', 'active', 'suspended', 'left')),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table profiles (
  user_id uuid primary key references users(id) on delete cascade,
  title text,
  department text,
  company text,
  bio text,
  work_hours_json jsonb not null default '{}',
  public_profile_json jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table web_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  session_auth_version integer not null check (session_auth_version > 0),
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text,
  check (idle_expires_at <= expires_at)
);

create index web_sessions_active_user_idx
  on web_sessions(user_id, expires_at desc)
  where revoked_at is null;

create index web_sessions_expiry_idx
  on web_sessions(expires_at)
  where revoked_at is null;

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),
  actor_id uuid references users(id),
  action text not null,
  target_type text not null,
  target_id uuid,
  metadata_json jsonb not null default '{}',
  ip_address inet,
  created_at timestamptz not null default now()
);

create index audit_logs_actor_created_idx on audit_logs(actor_id, created_at desc);
create index audit_logs_target_created_idx on audit_logs(target_type, target_id, created_at desc);

insert into organizations (id, name, plan)
values ('00000000-0000-4000-8000-000000000001', 'Inviz', 'business')
on conflict (id) do nothing;

insert into users (id, public_id, email, display_name, status)
values
  ('00000000-0000-4000-8000-000000000101', 'user-you', 'you@inviz.co.kr', 'HahaTalk Owner', 'invited'),
  ('00000000-0000-4000-8000-000000000102', 'user-mina', 'mina@inviz.co.kr', 'Mina Kim', 'invited'),
  ('00000000-0000-4000-8000-000000000103', 'user-jun', 'jun@inviz.co.kr', 'Jun Park', 'invited'),
  ('00000000-0000-4000-8000-000000000104', 'guest-hana', 'hana.customer@example.com', 'Hana Guest', 'invited')
on conflict (id) do nothing;

insert into organization_memberships (organization_id, user_id, role, status)
values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'owner', 'pending'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000102', 'admin', 'pending'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000103', 'member', 'pending'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000104', 'guest', 'pending')
on conflict (organization_id, user_id) do nothing;

insert into profiles (user_id, public_profile_json)
values
  ('00000000-0000-4000-8000-000000000101', '{"characterId":"char-calm-lead"}'),
  ('00000000-0000-4000-8000-000000000102', '{"characterId":"char-focus-maker"}'),
  ('00000000-0000-4000-8000-000000000103', '{"characterId":"char-calm-lead"}'),
  ('00000000-0000-4000-8000-000000000104', '{"characterId":"char-customer-guest"}')
on conflict (user_id) do nothing;
