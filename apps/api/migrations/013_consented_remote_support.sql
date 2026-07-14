create table remote_support_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  space_id uuid not null references conversation_spaces(id) on delete cascade,
  call_session_id uuid not null references call_sessions(id) on delete restrict,
  requester_id uuid not null references users(id),
  target_user_id uuid not null references users(id),
  requested_scopes text[] not null,
  policy_version text not null default 'hahatalk-remote-support-v1',
  engine text not null default 'native_agent' check (engine = 'native_agent'),
  agent_mode text not null default 'dry_run' check (agent_mode in ('dry_run', 'signed_native')),
  status text not null default 'requested' check (status in (
    'requested', 'approved', 'active', 'paused',
    'ended', 'declined', 'revoked', 'expired', 'failed'
  )),
  control_epoch bigint not null default 1 check (control_epoch > 0),
  next_command_sequence bigint not null default 1 check (next_command_sequence > 0),
  target_device_id text,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  started_at timestamptz,
  paused_at timestamptz,
  last_activity_at timestamptz not null default now(),
  absolute_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  updated_at timestamptz not null default now(),
  check (requester_id <> target_user_id),
  check (cardinality(requested_scopes) between 1 and 4),
  check ('screen_view' = any(requested_scopes)),
  check (requested_scopes <@ array['screen_view', 'remote_control', 'clipboard', 'file_transfer']::text[]),
  check (absolute_expires_at > requested_at),
  check (idle_expires_at > requested_at and idle_expires_at <= absolute_expires_at),
  check (target_device_id is null or char_length(target_device_id) between 8 and 160),
  check (end_reason is null or char_length(end_reason) <= 160),
  check ((status in ('ended', 'declined', 'revoked', 'expired', 'failed')) = (ended_at is not null)),
  check (status not in ('approved', 'active', 'paused') or approved_at is not null)
);

create index remote_support_sessions_actor_idx
  on remote_support_sessions(organization_id, requester_id, target_user_id, requested_at desc);

create index remote_support_sessions_expiry_idx
  on remote_support_sessions(status, idle_expires_at, absolute_expires_at)
  where status in ('requested', 'approved', 'active', 'paused');

create unique index remote_support_sessions_one_live_target_idx
  on remote_support_sessions(target_user_id)
  where status in ('requested', 'approved', 'active', 'paused');

create table remote_support_consents (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  subject_user_id uuid not null references users(id),
  scope text not null check (scope in ('screen_view', 'remote_control', 'clipboard', 'file_transfer')),
  decision text not null default 'pending' check (decision in ('pending', 'granted', 'denied', 'revoked')),
  policy_version text not null,
  disclosure_digest text not null check (char_length(disclosure_digest) = 64),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  unique (session_id, scope),
  check (expires_at > created_at),
  check ((decision = 'pending') = (decided_at is null)),
  check ((decision = 'revoked') = (revoked_at is not null))
);

create index remote_support_consents_subject_idx
  on remote_support_consents(subject_user_id, decision, expires_at desc);

create table remote_support_agent_credentials (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  target_user_id uuid not null references users(id),
  credential_kind text not null check (credential_kind in ('activation', 'agent')),
  token_digest bytea not null unique,
  control_epoch bigint not null check (control_epoch > 0),
  agent_mode text not null check (agent_mode in ('dry_run', 'signed_native')),
  agent_instance_id text,
  status text not null default 'active' check (status in ('active', 'consumed', 'revoked', 'expired')),
  issued_at timestamptz not null default now(),
  used_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (octet_length(token_digest) = 32),
  check (expires_at > issued_at),
  check (agent_instance_id is null or char_length(agent_instance_id) between 8 and 160),
  check (status <> 'consumed' or used_at is not null),
  check ((status = 'revoked') = (revoked_at is not null))
);

create unique index remote_support_agent_credentials_one_active_agent_idx
  on remote_support_agent_credentials(session_id)
  where credential_kind = 'agent' and status = 'active';

create index remote_support_agent_credentials_expiry_idx
  on remote_support_agent_credentials(status, expires_at)
  where status = 'active';

create table remote_support_commands (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  requested_by uuid not null references users(id),
  client_command_id text not null,
  request_hash text not null check (char_length(request_hash) = 64),
  control_epoch bigint not null check (control_epoch > 0),
  sequence bigint not null check (sequence > 0),
  command_kind text not null check (command_kind in ('pointer_move', 'pointer_button', 'wheel', 'key')),
  payload_json jsonb not null,
  status text not null default 'queued' check (status in (
    'queued', 'claimed', 'executed', 'simulated', 'rejected', 'expired', 'cancelled'
  )),
  claimed_by uuid references remote_support_agent_credentials(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  result_code text,
  unique (session_id, control_epoch, sequence),
  unique (session_id, requested_by, client_command_id),
  check (char_length(client_command_id) between 8 and 160),
  check (jsonb_typeof(payload_json) = 'object'),
  check (expires_at > created_at),
  check ((status in ('queued', 'claimed')) = (completed_at is null)),
  check (status <> 'claimed' or (claimed_by is not null and claimed_at is not null)),
  check (result_code is null or char_length(result_code) <= 120)
);

create index remote_support_commands_agent_queue_idx
  on remote_support_commands(session_id, control_epoch, status, sequence)
  where status in ('queued', 'claimed');

create index remote_support_commands_expiry_idx
  on remote_support_commands(status, expires_at)
  where status in ('queued', 'claimed');

create table remote_support_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  actor_id uuid references users(id),
  agent_instance_id text,
  event_type text not null,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  check (char_length(event_type) between 3 and 100),
  check (agent_instance_id is null or char_length(agent_instance_id) between 8 and 160),
  check (jsonb_typeof(metadata_json) = 'object')
);

create index remote_support_events_session_idx
  on remote_support_events(session_id, created_at, id);
