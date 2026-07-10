-- HahaTalk PostgreSQL V2 domain schema.
-- PostgreSQL stores identity, consent, conversation, delivery, media metadata,
-- schedules, AI jobs, and audit state. An S3-compatible provider stores binary objects.

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
  updated_at timestamptz not null default now()
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

-- Browser/Desktop clients hold only the opaque cookie token. PostgreSQL stores
-- its SHA-256 digest so a database read does not disclose a reusable session.
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

create table consent_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  consent_type text not null check (consent_type in (
    'terms', 'privacy', 'group_join', 'screen_share', 'remote_view', 'remote_control',
    'recording', 'ai_transcript', 'voice_profile', 'avatar_source_retention', 'external_share'
  )),
  scope_type text not null,
  scope_id uuid,
  decision text not null check (decision in ('granted', 'denied', 'revoked', 'expired')),
  policy_version text,
  evidence_json jsonb not null default '{}',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index consent_records_scope_idx on consent_records(scope_type, scope_id, consent_type);
create index consent_records_user_idx on consent_records(user_id, created_at desc);

-- Owner-managed address book collections. A private collection does not tell
-- its members that they have been grouped as family, customers, or another cohort.
create table contact_collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('family', 'team', 'customers', 'service', 'custom')),
  visibility text not null default 'owner_only' check (visibility in ('owner_only', 'shared')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table contact_collection_members (
  collection_id uuid not null references contact_collections(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  label text,
  sort_order integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (collection_id, user_id)
);

create table conversation_spaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  type text not null check (type in ('direct', 'open_group', 'hub', 'broadcast_channel', 'meeting_backstage')),
  name text not null,
  owner_id uuid not null references users(id),
  roster_visibility text not null check (roster_visibility in ('shared', 'owner_only', 'subscriber_count_only')),
  join_approval_policy text not null default 'owner_and_invitee' check (join_approval_policy in (
    'owner_and_invitee', 'admins_and_invitee', 'all_members_and_invitee', 'quorum_and_invitee'
  )),
  settings_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table space_memberships (
  space_id uuid not null references conversation_spaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'guest', 'subscriber')),
  view_mode text not null check (view_mode in ('owner_console', 'shared_room', 'direct_with_owner', 'channel')),
  status text not null default 'active' check (status in ('pending', 'active', 'muted', 'left', 'removed')),
  joined_at timestamptz not null default now(),
  muted_until timestamptz,
  last_read_message_id uuid,
  last_read_at timestamptz,
  primary key (space_id, user_id)
);

create index space_memberships_user_idx on space_memberships(user_id, status, joined_at desc);

-- Each hub participant owns one isolated spoke with the hub owner. Only the
-- owner console can aggregate multiple spokes.
create table hub_spokes (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references conversation_spaces(id) on delete cascade,
  owner_id uuid not null references users(id),
  participant_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check (owner_id <> participant_id),
  unique (space_id, participant_id)
);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  invited_by uuid not null references users(id),
  invitee_user_id uuid references users(id),
  invitee_email citext,
  target_type text not null check (target_type in ('connection', 'space', 'collection', 'event', 'channel')),
  target_id uuid not null,
  requested_role text,
  approval_policy text not null check (approval_policy in (
    'owner_and_invitee', 'admins_and_invitee', 'all_members_and_invitee', 'quorum_and_invitee'
  )),
  required_approval_count integer not null check (required_approval_count >= 1),
  status text not null check (status in ('draft', 'pending_approval', 'sent', 'accepted', 'declined', 'expired', 'revoked')),
  token_hash text unique,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check (invitee_user_id is not null or invitee_email is not null)
);

create table invitation_approvals (
  invitation_id uuid not null references invitations(id) on delete cascade,
  approver_id uuid not null references users(id),
  decision text not null check (decision in ('approved', 'rejected', 'revoked')),
  decided_at timestamptz not null default now(),
  note text,
  primary key (invitation_id, approver_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references conversation_spaces(id) on delete cascade,
  sender_id uuid not null references users(id),
  client_message_id text not null,
  parent_message_id uuid references messages(id),
  message_type text not null check (message_type in (
    'text', 'image', 'file', 'audio', 'video', 'system', 'schedule', 'poll', 'sticker', 'remote_support'
  )),
  delivery_mode text not null check (delivery_mode in (
    'direct', 'shared', 'hub_fanout', 'hub_announcement', 'broadcast', 'role'
  )),
  body text not null default '',
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  unique (sender_id, client_message_id)
);

-- Audience rows preserve the sender's intent. Delivery rows are the immutable,
-- security-critical recipient snapshot used by API and realtime reads.
create table message_audiences (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  audience_type text not null check (audience_type in ('all', 'selected', 'private', 'role')),
  target_user_id uuid references users(id),
  target_role text,
  created_at timestamptz not null default now(),
  check (
    (audience_type in ('selected', 'private') and target_user_id is not null and target_role is null)
    or (audience_type = 'role' and target_role is not null and target_user_id is null)
    or (audience_type = 'all' and target_user_id is null and target_role is null)
  )
);

create table message_deliveries (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  recipient_id uuid not null references users(id),
  thread_key text not null,
  status text not null check (status in ('pending', 'delivered', 'failed', 'revoked')),
  delivered_at timestamptz,
  read_at timestamptz,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (message_id, recipient_id)
);

create index messages_space_timeline_idx on messages(space_id, created_at desc, id desc) where deleted_at is null;
create index message_audiences_target_idx on message_audiences(target_user_id, message_id) where target_user_id is not null;
create index message_deliveries_recipient_idx on message_deliveries(recipient_id, delivered_at desc, message_id) where revoked_at is null;
create index message_deliveries_thread_idx on message_deliveries(thread_key, delivered_at desc, message_id) where revoked_at is null;

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id),
  storage_key text not null unique,
  original_file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256_hex text,
  captured_at timestamptz,
  captured_timezone text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  place_name text,
  exif_json jsonb not null default '{}',
  archive_scope text not null check (archive_scope in ('private_archive', 'shared', 'selected')),
  preview_status text not null check (preview_status in ('queued', 'ready', 'failed')),
  virus_scan_status text not null check (virus_scan_status in ('pending', 'clean', 'blocked')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table media_variants (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references media_assets(id) on delete cascade,
  variant_type text not null check (variant_type in ('thumbnail', 'preview', 'transcoded', 'gps_stripped', 'waveform', 'poster')),
  storage_key text not null unique,
  mime_type text not null,
  width integer,
  height integer,
  duration_ms integer,
  created_at timestamptz not null default now(),
  unique (asset_id, variant_type)
);

create table message_attachments (
  message_id uuid not null references messages(id) on delete cascade,
  asset_id uuid not null references media_assets(id),
  sort_order integer not null default 0,
  caption text,
  primary key (message_id, asset_id)
);

create table media_shares (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references media_assets(id),
  space_id uuid not null references conversation_spaces(id) on delete cascade,
  shared_by uuid not null references users(id),
  visibility text not null check (visibility in ('all', 'selected', 'private')),
  shared_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table albums (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id),
  space_id uuid references conversation_spaces(id) on delete cascade,
  name text not null,
  scope text not null check (scope in ('private_archive', 'shared_space')),
  grouping_policy text not null default 'manual' check (grouping_policy in ('manual', 'date', 'place', 'date_and_place')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table album_items (
  album_id uuid not null references albums(id) on delete cascade,
  asset_id uuid not null references media_assets(id) on delete cascade,
  sort_order integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (album_id, asset_id)
);

create index media_assets_owner_time_idx on media_assets(owner_id, captured_at desc nulls last, created_at desc);
create index media_assets_place_idx on media_assets(owner_id, place_name, captured_at desc) where place_name is not null;
create index media_shares_space_idx on media_shares(space_id, shared_at desc) where revoked_at is null;

create table sticker_packs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null check (category in ('emotion', 'celebration', 'comfort', 'work', 'custom')),
  status text not null check (status in ('draft', 'active', 'retired')),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table stickers (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references sticker_packs(id) on delete cascade,
  name text not null,
  asset_key text not null,
  animation_format text check (animation_format in ('static_webp', 'animated_webp', 'lottie')),
  accessibility_label text not null,
  sort_order integer not null default 0
);

create table message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  emoji text,
  sticker_id uuid references stickers(id),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id),
  check (((emoji is not null)::integer + (sticker_id is not null)::integer) = 1)
);

create table events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  space_id uuid references conversation_spaces(id) on delete set null,
  created_by uuid not null references users(id),
  title text not null,
  description text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  recurrence_rule text,
  status text not null check (status in ('draft', 'scheduled', 'cancelled', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table event_attendees (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid references users(id),
  external_email citext,
  status text not null check (status in ('invited', 'accepted', 'declined', 'tentative', 'attended', 'no_show')),
  responded_at timestamptz,
  check (user_id is not null or external_email is not null)
);

create unique index event_attendees_user_unique on event_attendees(event_id, user_id) where user_id is not null;
create unique index event_attendees_email_unique on event_attendees(event_id, external_email) where external_email is not null;

create table call_sessions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references conversation_spaces(id) on delete cascade,
  event_id uuid references events(id) on delete set null,
  created_by uuid not null references users(id),
  call_type text not null check (call_type in ('voice', 'video', 'webinar', 'screen_share')),
  provider text not null default 'livekit',
  provider_room_id text unique,
  status text not null check (status in ('scheduled', 'lobby', 'active', 'ended', 'cancelled', 'failed')),
  background_mode text check (background_mode in ('none', 'blur', 'image', 'avatar')),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table call_participants (
  call_session_id uuid not null references call_sessions(id) on delete cascade,
  user_id uuid not null references users(id),
  role text not null check (role in ('host', 'cohost', 'speaker', 'attendee', 'viewer')),
  joined_at timestamptz,
  left_at timestamptz,
  media_state_json jsonb not null default '{}',
  primary key (call_session_id, user_id)
);

create table call_recordings (
  id uuid primary key default gen_random_uuid(),
  call_session_id uuid not null references call_sessions(id) on delete cascade,
  asset_id uuid not null references media_assets(id),
  started_by uuid not null references users(id),
  consent_snapshot_json jsonb not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null check (status in ('recording', 'processing', 'ready', 'failed', 'deleted'))
);

create table broadcast_channels (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null unique references conversation_spaces(id) on delete cascade,
  owner_id uuid not null references users(id),
  handle citext not null unique,
  description text not null default '',
  moderation_policy_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table channel_subscriptions (
  channel_id uuid not null references broadcast_channels(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null check (status in ('active', 'muted', 'blocked', 'left')),
  subscribed_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table broadcast_sessions (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references broadcast_channels(id) on delete cascade,
  call_session_id uuid not null unique references call_sessions(id) on delete cascade,
  title text not null,
  chat_mode text not null check (chat_mode in ('disabled', 'followers', 'subscribers', 'moderated')),
  status text not null check (status in ('scheduled', 'live', 'ended', 'cancelled')),
  created_at timestamptz not null default now()
);

create table avatar_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  source_asset_id uuid references media_assets(id) on delete set null,
  display_asset_id uuid references media_assets(id) on delete set null,
  avatar_type text not null check (avatar_type in ('preset', 'photo', 'caricature', 'animated_2d', 'animated_3d')),
  animation_profile_json jsonb not null default '{}',
  consent_to_store_source boolean not null default false,
  selected_at timestamptz,
  created_at timestamptz not null default now()
);

create table ai_model_configs (
  id uuid primary key default gen_random_uuid(),
  capability text not null check (capability in ('assistant', 'summary', 'stt', 'tts', 'avatar', 'moderation')),
  provider text not null,
  model_name text not null,
  minimum_version text,
  deployment_mode text not null check (deployment_mode in ('local', 'private_server', 'managed_api')),
  settings_json jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (capability, provider, model_name)
);

create table ai_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  requested_by uuid not null references users(id),
  model_config_id uuid references ai_model_configs(id),
  job_type text not null check (job_type in (
    'stt', 'tts', 'summary', 'avatar_generation', 'transcript', 'search_index', 'media_metadata'
  )),
  input_asset_id uuid references media_assets(id),
  idempotency_key text not null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer not null default 0,
  result_json jsonb,
  error_code text,
  error_message text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (requested_by, idempotency_key)
);

create index ai_jobs_worker_idx on ai_jobs(status, available_at, created_at) where status in ('queued', 'failed');

create table voice_transcripts (
  id uuid primary key default gen_random_uuid(),
  ai_job_id uuid not null unique references ai_jobs(id) on delete cascade,
  source_type text not null check (source_type in ('voice_message', 'call', 'broadcast', 'uploaded_media')),
  source_id uuid not null,
  language text not null,
  text text not null,
  segments_json jsonb not null default '[]',
  review_status text not null check (review_status in ('ai_draft', 'reviewed', 'rejected')),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table voice_profiles (
  id uuid primary key default gen_random_uuid(),
  subject_user_id uuid not null references users(id) on delete cascade,
  created_by uuid not null references users(id),
  reference_asset_id uuid not null references media_assets(id),
  model_config_id uuid not null references ai_model_configs(id),
  encrypted_embedding_key text,
  consent_record_id uuid not null references consent_records(id),
  status text not null check (status in ('pending_consent', 'active', 'revoked', 'deleted')),
  watermark_required boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table tts_assets (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references users(id),
  voice_profile_id uuid references voice_profiles(id),
  model_config_id uuid not null references ai_model_configs(id),
  text_hash text not null,
  settings_hash text not null,
  storage_key text not null unique,
  duration_ms integer,
  watermarked boolean not null default false,
  created_at timestamptz not null default now(),
  unique (text_hash, settings_hash, voice_profile_id, model_config_id)
);

create table remote_support_sessions (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references conversation_spaces(id) on delete cascade,
  requester_id uuid not null references users(id),
  supporter_id uuid not null references users(id),
  target_device_id text not null,
  engine text not null check (engine in ('meshcentral', 'native_agent')),
  status text not null check (status in (
    'requested', 'view_approved', 'control_approved', 'active', 'paused', 'ended', 'revoked', 'failed'
  )),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz not null,
  check (requester_id <> supporter_id)
);

create table remote_support_consents (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  granted_by uuid not null references users(id),
  capability text not null check (capability in ('screen_view', 'remote_control', 'clipboard', 'file_transfer')),
  decision text not null check (decision in ('granted', 'denied', 'revoked')),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  unique (session_id, capability, granted_by)
);

create table remote_support_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  actor_id uuid references users(id),
  event_type text not null,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  actor_id uuid references users(id),
  action text not null,
  target_type text not null,
  target_id uuid,
  request_id text,
  ip_address inet,
  user_agent text,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_logs_target_idx on audit_logs(target_type, target_id, created_at desc);
create index audit_logs_actor_idx on audit_logs(actor_id, created_at desc);

create table idempotency_keys (
  scope text not null,
  key text not null,
  owner_id uuid not null references users(id),
  request_hash text not null,
  response_json jsonb,
  status_code integer,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (scope, key, owner_id)
);

create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempt_count integer not null default 0,
  last_error text
);

create index outbox_events_unpublished_idx on outbox_events(created_at) where published_at is null;

-- Security contract for application queries:
-- 1. Persist message + audience + deliveries + outbox event in one transaction.
-- 2. Read messages by joining message_deliveries on the authenticated recipient.
-- 3. Only the hub owner console may request aggregate deliveries and audience rows.
-- 4. Participant APIs must return a direct-room presentation and strip other deliveries.
-- 5. Remote support, recording, voice profiles, transcript export, and external sharing
--    require a current consent record and an append-only audit event.
