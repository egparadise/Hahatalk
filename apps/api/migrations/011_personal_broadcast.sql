alter table call_sessions
  drop constraint call_sessions_session_kind_check;

alter table call_sessions
  add constraint call_sessions_session_kind_check
  check (session_kind in ('ad_hoc', 'scheduled_meeting', 'broadcast'));

alter table call_sessions
  drop constraint call_sessions_schedule_link_check;

alter table call_sessions
  add constraint call_sessions_schedule_link_check
  check (
    (session_kind in ('ad_hoc', 'broadcast')
      and event_id is null
      and event_version is null
      and occurrence_starts_at is null
      and occurrence_ends_at is null
      and lobby_opens_at is null
      and lobby_opened_at is null)
    or
    (session_kind = 'scheduled_meeting'
      and event_id is not null
      and event_version is not null
      and occurrence_starts_at is not null
      and occurrence_ends_at is not null
      and lobby_opens_at is not null
      and occurrence_ends_at > occurrence_starts_at
      and lobby_opens_at < occurrence_ends_at
      and expires_at > occurrence_ends_at)
  );

alter table call_participants
  drop constraint call_participants_role_check;

alter table call_participants
  add constraint call_participants_role_check
  check (role in ('host', 'participant', 'cohost', 'speaker', 'attendee', 'viewer'));

create table broadcast_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  space_id uuid not null unique references conversation_spaces(id) on delete cascade,
  owner_id uuid not null references users(id),
  handle citext not null,
  name text not null,
  description text not null default '',
  visibility text not null default 'organization' check (visibility in ('organization', 'unlisted')),
  moderation_policy_json jsonb not null default '{"viewerIdentity":"hidden","questionMode":"moderated"}',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (organization_id, handle),
  check (handle::text ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  check (char_length(name) between 2 and 80),
  check (char_length(description) <= 500),
  check (jsonb_typeof(moderation_policy_json) = 'object')
);

create index broadcast_channels_org_updated_idx
  on broadcast_channels(organization_id, updated_at desc, id)
  where archived_at is null;

create index broadcast_channels_owner_updated_idx
  on broadcast_channels(owner_id, updated_at desc, id)
  where archived_at is null;

create table channel_subscriptions (
  channel_id uuid not null references broadcast_channels(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null check (status in ('active', 'muted', 'blocked', 'left')),
  notification_level text not null default 'live_only' check (notification_level in ('all', 'live_only', 'off')),
  blocked_by uuid references users(id),
  block_reason text,
  subscribed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  left_at timestamptz,
  blocked_at timestamptz,
  version integer not null default 1 check (version > 0),
  primary key (channel_id, user_id),
  check (block_reason is null or char_length(block_reason) <= 160),
  check (
    (status = 'blocked' and blocked_by is not null and blocked_at is not null)
    or
    (status <> 'blocked' and blocked_by is null and blocked_at is null and block_reason is null)
  )
);

create index channel_subscriptions_user_status_idx
  on channel_subscriptions(user_id, status, updated_at desc);

create index channel_subscriptions_channel_active_idx
  on channel_subscriptions(channel_id, subscribed_at, user_id)
  where status in ('active', 'muted');

create table broadcast_sessions (
  id uuid primary key,
  channel_id uuid not null references broadcast_channels(id) on delete cascade,
  call_session_id uuid not null unique references call_sessions(id) on delete cascade,
  created_by uuid not null references users(id),
  client_session_id text not null,
  title text not null,
  description text not null default '',
  chat_mode text not null check (chat_mode in ('disabled', 'subscribers', 'moderated')),
  status text not null check (status in ('scheduled', 'starting', 'live', 'ended', 'cancelled', 'failed')),
  scheduled_for timestamptz not null,
  expected_end_at timestamptz not null,
  viewer_limit integer not null default 500 check (viewer_limit between 1 and 3000),
  replay_requested boolean not null default true,
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (created_by, client_session_id),
  check (id = call_session_id),
  check (char_length(client_session_id) between 8 and 160),
  check (char_length(title) between 2 and 120),
  check (char_length(description) <= 1000),
  check (expected_end_at > scheduled_for),
  check (expected_end_at <= scheduled_for + interval '12 hours'),
  check (end_reason is null or char_length(end_reason) <= 160),
  check ((status in ('ended', 'cancelled', 'failed')) = (ended_at is not null))
);

create unique index broadcast_sessions_one_live_channel_idx
  on broadcast_sessions(channel_id)
  where status in ('starting', 'live');

create index broadcast_sessions_channel_schedule_idx
  on broadcast_sessions(channel_id, scheduled_for desc, id desc);

create index broadcast_sessions_org_live_idx
  on broadcast_sessions(status, scheduled_for, id)
  where status in ('scheduled', 'starting', 'live');

create table broadcast_messages (
  id uuid primary key default gen_random_uuid(),
  broadcast_session_id uuid not null references broadcast_sessions(id) on delete cascade,
  sender_id uuid not null references users(id),
  client_message_id text not null,
  kind text not null check (kind in ('chat', 'question', 'announcement')),
  status text not null check (status in ('pending', 'published', 'hidden', 'dismissed', 'deleted')),
  body text not null,
  anonymous_to_viewers boolean not null default true,
  moderated_by uuid references users(id),
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (broadcast_session_id, sender_id, client_message_id),
  check (char_length(client_message_id) between 8 and 160),
  check (char_length(body) between 1 and 2000),
  check (
    (moderated_by is null and moderated_at is null)
    or
    (moderated_by is not null and moderated_at is not null)
  )
);

create index broadcast_messages_public_timeline_idx
  on broadcast_messages(broadcast_session_id, created_at, id)
  where status = 'published';

create index broadcast_messages_moderation_queue_idx
  on broadcast_messages(broadcast_session_id, status, created_at, id)
  where status in ('pending', 'hidden');

create table broadcast_reactions (
  id uuid primary key default gen_random_uuid(),
  broadcast_session_id uuid not null references broadcast_sessions(id) on delete cascade,
  sender_id uuid not null references users(id),
  client_reaction_id text not null,
  reaction text not null check (reaction in ('like', 'applause', 'thanks', 'question', 'celebrate')),
  created_at timestamptz not null default now(),
  unique (broadcast_session_id, sender_id, client_reaction_id),
  check (char_length(client_reaction_id) between 8 and 160)
);

create index broadcast_reactions_rate_idx
  on broadcast_reactions(broadcast_session_id, sender_id, created_at desc);

create table broadcast_moderation_actions (
  id uuid primary key default gen_random_uuid(),
  broadcast_session_id uuid not null references broadcast_sessions(id) on delete cascade,
  actor_id uuid not null references users(id),
  action text not null check (action in (
    'publish_message', 'hide_message', 'restore_message', 'dismiss_question',
    'remove_participant', 'block_subscriber', 'unblock_subscriber', 'change_role'
  )),
  target_user_id uuid references users(id),
  target_message_id uuid references broadcast_messages(id) on delete set null,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  check (jsonb_typeof(metadata_json) = 'object'),
  check (target_user_id is not null or target_message_id is not null)
);

create index broadcast_moderation_actions_session_idx
  on broadcast_moderation_actions(broadcast_session_id, created_at desc, id desc);

create table broadcast_replays (
  id uuid primary key default gen_random_uuid(),
  broadcast_session_id uuid not null unique references broadcast_sessions(id) on delete cascade,
  recording_id uuid unique references call_recordings(id) on delete set null,
  media_asset_id uuid unique references media_assets(id) on delete set null,
  status text not null check (status in ('not_requested', 'processing', 'ready', 'failed', 'unavailable')),
  unavailable_reason text,
  available_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (unavailable_reason is null or char_length(unavailable_reason) <= 160),
  check (
    (status = 'ready' and media_asset_id is not null and available_at is not null)
    or
    (status <> 'ready' and media_asset_id is null and available_at is null)
  )
);

create index broadcast_replays_status_idx
  on broadcast_replays(status, updated_at)
  where status in ('processing', 'failed', 'unavailable');

create table broadcast_private_handoffs (
  channel_id uuid not null references broadcast_channels(id) on delete cascade,
  requester_id uuid not null references users(id) on delete cascade,
  direct_space_id uuid not null unique references conversation_spaces(id) on delete cascade,
  requested_at timestamptz not null default now(),
  primary key (channel_id, requester_id)
);

create table broadcast_events (
  id uuid primary key default gen_random_uuid(),
  broadcast_session_id uuid not null references broadcast_sessions(id) on delete cascade,
  actor_id uuid references users(id),
  event_type text not null,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  check (char_length(event_type) between 3 and 100),
  check (jsonb_typeof(metadata_json) = 'object')
);

create index broadcast_events_session_created_idx
  on broadcast_events(broadcast_session_id, created_at, id);

create index broadcast_events_actor_created_idx
  on broadcast_events(actor_id, created_at desc)
  where actor_id is not null;
