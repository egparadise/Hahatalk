create table call_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  space_id uuid not null references conversation_spaces(id) on delete cascade,
  created_by uuid not null references users(id),
  call_type text not null check (call_type in ('voice', 'video')),
  provider text not null default 'livekit' check (provider = 'livekit'),
  provider_room_name text not null unique,
  status text not null check (status in ('starting', 'ringing', 'active', 'ended', 'cancelled', 'failed', 'expired')),
  version integer not null default 1 check (version > 0),
  expires_at timestamptz not null,
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(provider_room_name) between 24 and 160),
  check (end_reason is null or char_length(end_reason) <= 160),
  check ((status in ('ended', 'cancelled', 'failed', 'expired')) = (ended_at is not null))
);

create index call_sessions_space_created_idx
  on call_sessions(space_id, created_at desc, id desc);

create index call_sessions_org_live_idx
  on call_sessions(organization_id, status, expires_at)
  where status in ('starting', 'ringing', 'active');

create table call_participants (
  call_session_id uuid not null references call_sessions(id) on delete cascade,
  user_id uuid not null references users(id),
  role text not null check (role in ('host', 'participant')),
  status text not null check (status in ('invited', 'connecting', 'joined', 'declined', 'left', 'removed', 'missed')),
  provider_identity text not null unique,
  can_publish_audio boolean not null default true,
  can_publish_video boolean not null default false,
  token_version integer not null default 1 check (token_version > 0),
  invited_at timestamptz not null default now(),
  connecting_at timestamptz,
  joined_at timestamptz,
  left_at timestamptz,
  declined_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (call_session_id, user_id),
  check (char_length(provider_identity) between 24 and 160),
  check (can_publish_video = false or can_publish_audio = true)
);

create index call_participants_user_status_idx
  on call_participants(user_id, status, invited_at desc);

create table call_events (
  id uuid primary key default gen_random_uuid(),
  call_session_id uuid not null references call_sessions(id) on delete cascade,
  actor_id uuid references users(id),
  participant_id uuid references users(id),
  event_type text not null,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  check (char_length(event_type) between 3 and 100),
  check (jsonb_typeof(metadata_json) = 'object')
);

create index call_events_call_created_idx
  on call_events(call_session_id, created_at, id);

create index call_events_participant_created_idx
  on call_events(participant_id, created_at desc)
  where participant_id is not null;
