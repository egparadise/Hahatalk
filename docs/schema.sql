-- HahaTalk MVP schema draft.
-- PostgreSQL should store relational metadata; S3/MinIO stores original file bytes.

create table organizations (
  id uuid primary key,
  name text not null,
  plan text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  email text not null,
  phone text,
  password_hash text not null,
  display_name text not null,
  status text not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table rooms (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  type text not null,
  name text not null,
  owner_id uuid not null references users(id),
  settings_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table room_members (
  room_id uuid not null references rooms(id),
  user_id uuid not null references users(id),
  role text not null,
  joined_at timestamptz not null default now(),
  muted_until timestamptz,
  last_read_message_id uuid,
  last_read_at timestamptz,
  primary key (room_id, user_id)
);

create table messages (
  id uuid primary key,
  room_id uuid not null references rooms(id),
  sender_id uuid not null references users(id),
  parent_message_id uuid references messages(id),
  message_type text not null,
  body text not null,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create table message_audiences (
  id uuid primary key,
  message_id uuid not null references messages(id) on delete cascade,
  audience_type text not null,
  target_user_id uuid references users(id),
  target_role text
);

create index message_audiences_message_idx on message_audiences(message_id);
create index message_audiences_target_user_idx on message_audiences(target_user_id);

create table message_reads (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references users(id),
  read_at timestamptz not null,
  confirmed_at timestamptz,
  primary key (message_id, user_id)
);

create table attachments (
  id uuid primary key,
  message_id uuid not null references messages(id) on delete cascade,
  uploader_id uuid not null references users(id),
  storage_key text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  thumbnail_key text,
  preview_status text not null,
  virus_scan_status text not null,
  version_group_id uuid,
  created_at timestamptz not null default now()
);

create table ai_jobs (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  requested_by uuid not null references users(id),
  job_type text not null,
  input_asset_id uuid,
  status text not null,
  result_json jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table audit_logs (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  actor_id uuid references users(id),
  action text not null,
  target_type text not null,
  target_id uuid,
  ip_address inet,
  user_agent text,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

