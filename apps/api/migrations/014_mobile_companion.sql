create table mobile_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  platform text not null check (platform in ('android', 'ios')),
  installation_id_hash bytea not null check (octet_length(installation_id_hash) = 32),
  access_token_hash bytea not null unique check (octet_length(access_token_hash) = 32),
  session_auth_version integer not null check (session_auth_version > 0),
  app_version text not null check (char_length(app_version) between 1 and 40),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  access_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text,
  check (access_expires_at > created_at),
  check (idle_expires_at > created_at and idle_expires_at <= absolute_expires_at),
  check (absolute_expires_at > created_at),
  check (revoke_reason is null or char_length(revoke_reason) <= 120)
);

create unique index mobile_sessions_active_installation_idx
  on mobile_sessions(user_id, installation_id_hash)
  where revoked_at is null;

create index mobile_sessions_access_idx
  on mobile_sessions(access_expires_at)
  where revoked_at is null;

create table mobile_refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references mobile_sessions(id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  generation integer not null check (generation > 0),
  status text not null default 'active' check (status in ('active', 'rotated', 'revoked', 'reused', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at),
  check ((status = 'active') = (consumed_at is null))
);

create unique index mobile_refresh_tokens_active_session_idx
  on mobile_refresh_tokens(session_id)
  where status = 'active';

create index mobile_refresh_tokens_expiry_idx
  on mobile_refresh_tokens(expires_at)
  where status = 'active';

create table mobile_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  mobile_session_id uuid references mobile_sessions(id) on delete set null,
  platform text not null check (platform in ('android', 'ios')),
  installation_id_hash bytea not null check (octet_length(installation_id_hash) = 32),
  push_provider text not null check (push_provider in ('expo', 'fcm', 'apns')),
  push_token_digest bytea not null check (octet_length(push_token_digest) = 32),
  push_token_ciphertext bytea not null,
  push_token_nonce bytea not null check (octet_length(push_token_nonce) = 12),
  push_token_auth_tag bytea not null check (octet_length(push_token_auth_tag) = 16),
  encryption_key_id text not null check (char_length(encryption_key_id) between 1 and 80),
  app_version text not null check (char_length(app_version) between 1 and 40),
  os_version text not null check (char_length(os_version) between 1 and 80),
  locale text not null check (char_length(locale) between 2 and 32),
  timezone text not null check (char_length(timezone) between 1 and 80),
  capabilities_json jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text,
  check (jsonb_typeof(capabilities_json) = 'object'),
  check ((status = 'revoked') = (revoked_at is not null)),
  check (revoke_reason is null or char_length(revoke_reason) <= 120)
);

create unique index mobile_devices_active_installation_idx
  on mobile_devices(user_id, installation_id_hash)
  where status = 'active';

create unique index mobile_devices_active_push_token_idx
  on mobile_devices(push_token_digest)
  where status = 'active';

create index mobile_devices_session_idx
  on mobile_devices(mobile_session_id, status);

create table mobile_push_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  recipient_id uuid not null references users(id) on delete cascade,
  device_id uuid not null references mobile_devices(id) on delete cascade,
  event_key text not null check (char_length(event_key) between 8 and 180),
  event_type text not null check (event_type in ('conversation.message', 'calendar.reminder', 'call.invite', 'meeting.lobby', 'broadcast.started')),
  title text not null check (char_length(title) between 1 and 80),
  body text not null check (char_length(body) between 1 and 160),
  route text not null check (char_length(route) between 1 and 220 and route like '/%'),
  payload_json jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'claimed', 'delivered', 'failed', 'cancelled', 'expired')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 12),
  available_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, event_key),
  check (jsonb_typeof(payload_json) = 'object'),
  check (expires_at > created_at),
  check (claimed_by is null or char_length(claimed_by) between 8 and 160),
  check (provider_message_id is null or char_length(provider_message_id) <= 240),
  check (last_error_code is null or char_length(last_error_code) <= 120)
);

create index mobile_push_jobs_claim_idx
  on mobile_push_jobs(status, available_at, created_at)
  where status in ('queued', 'claimed');

create table mobile_push_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references mobile_push_jobs(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  worker_id text not null check (char_length(worker_id) between 8 and 160),
  outcome text not null check (outcome in ('claimed', 'delivered', 'failed', 'lease_expired')),
  error_code text,
  created_at timestamptz not null default now(),
  unique (job_id, attempt_number, outcome),
  check (error_code is null or char_length(error_code) <= 120)
);

create index mobile_push_attempts_job_idx
  on mobile_push_attempts(job_id, created_at desc);
