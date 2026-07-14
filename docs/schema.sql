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
  bootstrap_claim_allowed boolean not null default false,
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
  organization_id uuid references organizations(id) on delete cascade,
  subject_user_id uuid references users(id),
  subject_email citext,
  invitation_id uuid,
  consent_type text not null check (consent_type in (
    'terms', 'privacy', 'group_join', 'screen_share', 'remote_view', 'remote_control',
    'recording', 'ai_transcript', 'voice_profile', 'avatar_source_retention', 'external_share'
  )),
  scope_type text,
  scope_id uuid,
  decision text not null check (decision in ('granted', 'denied', 'revoked', 'expired')),
  policy_version text not null,
  evidence_json jsonb not null default '{}',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (subject_user_id is not null or subject_email is not null),
  check (
    (scope_type is null and scope_id is null) or
    (scope_type is not null and scope_id is not null)
  )
);

create index consent_records_scope_idx
  on consent_records(scope_type, scope_id, consent_type, created_at desc)
  where scope_type is not null and scope_id is not null;
create index consent_records_user_idx on consent_records(subject_user_id, created_at desc);
create index consent_records_invitation_idx on consent_records(invitation_id, created_at asc);

-- Owner-managed address book collections. A private collection does not tell
-- its members that they have been grouped as family, customers, or another cohort.
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
  check (visibility = 'owner_only' or kind in ('family', 'team'))
);

create unique index contact_collections_active_owner_name_idx
  on contact_collections(owner_id, lower(btrim(name)))
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
  primary key (collection_id, user_id)
);

create table contact_member_tags (
  collection_id uuid not null,
  user_id uuid not null,
  tag text not null,
  created_at timestamptz not null default now(),
  primary key (collection_id, user_id, tag),
  foreign key (collection_id, user_id)
    references contact_collection_members(collection_id, user_id) on delete cascade
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
  organization_id uuid not null references organizations(id) on delete cascade,
  invited_by uuid not null references users(id),
  invitee_user_id uuid references users(id),
  invitee_email citext,
  target_type text not null default 'organization' check (target_type in ('organization', 'connection', 'space', 'collection', 'event', 'channel')),
  target_id uuid,
  requested_role text not null check (requested_role in ('member', 'guest')),
  approval_policy text not null check (approval_policy in (
    'owner_and_invitee', 'admins_and_invitee', 'all_members_and_invitee', 'quorum_and_invitee'
  )),
  required_approval_count integer not null check (required_approval_count >= 1),
  status text not null check (status in ('pending_approval', 'sent', 'accepted', 'declined', 'expired', 'revoked')),
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
  check (invitee_user_id is not null or invitee_email is not null),
  check (expires_at > token_issued_at),
  check ((invitee_decision is null) = (invitee_decided_at is null))
);

create table invitation_approval_requirements (
  invitation_id uuid not null references invitations(id) on delete cascade,
  approver_id uuid not null references users(id),
  role_snapshot text not null check (role_snapshot in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (invitation_id, approver_id)
);

create table invitation_approvals (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references invitations(id) on delete cascade,
  approver_id uuid not null references users(id),
  decision text not null check (decision in ('approved', 'rejected')),
  decided_at timestamptz not null default now(),
  note text,
  unique (invitation_id, approver_id)
);

alter table consent_records
  add constraint consent_records_invitation_fk
  foreign key (invitation_id) references invitations(id) on delete set null;

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

create table media_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  client_upload_id text not null,
  original_file_name text not null,
  declared_mime_type text not null,
  expected_size_bytes bigint not null check (expected_size_bytes between 1 and 104857600),
  expected_sha256_hex text check (expected_sha256_hex is null or expected_sha256_hex ~ '^[0-9a-f]{64}$'),
  part_size_bytes integer not null check (part_size_bytes between 262144 and 8388608),
  part_count integer not null check (part_count between 1 and 400),
  source text not null check (source in ('file_upload', 'screen_capture', 'ai_generated')),
  generated_by_job_id uuid,
  status text not null check (status in ('initiated', 'uploading', 'completing', 'completed', 'aborted', 'expired', 'failed')),
  completed_asset_id uuid,
  failure_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (owner_id, client_upload_id),
  check (char_length(client_upload_id) between 8 and 160),
  check (char_length(original_file_name) between 1 and 255),
  check (char_length(declared_mime_type) between 3 and 160)
);

create index media_upload_sessions_owner_status_idx on media_upload_sessions(owner_id, status, updated_at desc);
create index media_upload_sessions_expiry_idx on media_upload_sessions(expires_at)
  where status in ('initiated', 'uploading', 'completing');

create table media_upload_parts (
  upload_id uuid not null references media_upload_sessions(id) on delete cascade,
  part_number integer not null check (part_number > 0),
  object_key text not null unique,
  size_bytes integer not null check (size_bytes > 0),
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  uploaded_at timestamptz not null default now(),
  primary key (upload_id, part_number)
);

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  original_object_key text not null unique,
  original_file_name text not null,
  declared_mime_type text not null,
  detected_mime_type text not null,
  media_kind text not null check (media_kind in ('image', 'video', 'audio', 'pdf', 'text', 'office', 'file')),
  size_bytes bigint not null check (size_bytes between 1 and 104857600),
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  archive_scope text not null default 'private_archive' check (archive_scope in ('private_archive', 'shared', 'selected')),
  processing_status text not null check (processing_status in ('processing', 'ready', 'blocked', 'failed')),
  preview_status text not null check (preview_status in ('queued', 'ready', 'unavailable', 'failed')),
  virus_scan_status text not null check (virus_scan_status in ('pending', 'clean', 'blocked', 'failed')),
  scan_engine text not null,
  scan_summary text,
  source text not null check (source in ('file_upload', 'screen_capture')),
  captured_at timestamptz,
  captured_local_at timestamp without time zone,
  captured_timezone text,
  place_name text,
  latitude double precision,
  longitude double precision,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_seconds double precision check (duration_seconds is null or duration_seconds >= 0),
  page_count integer check (page_count is null or page_count > 0),
  private_metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (char_length(original_file_name) between 1 and 255),
  check (latitude is null or latitude between -90 and 90),
  check (longitude is null or longitude between -180 and 180)
);

alter table media_upload_sessions
  add constraint media_upload_sessions_completed_asset_fk
  foreign key (completed_asset_id) references media_assets(id) on delete set null;

create index media_assets_owner_timeline_idx
  on media_assets(owner_id, captured_at desc nulls last, created_at desc, id desc)
  where deleted_at is null;
create index media_assets_owner_local_timeline_idx
  on media_assets(owner_id, captured_local_at desc nulls last, created_at desc, id desc)
  where deleted_at is null;
create index media_assets_owner_place_idx
  on media_assets(owner_id, lower(place_name), captured_at desc nulls last, created_at desc, id desc)
  where deleted_at is null and place_name is not null;
create index media_assets_owner_scope_idx
  on media_assets(owner_id, archive_scope, created_at desc, id desc)
  where deleted_at is null;

create table media_variants (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references media_assets(id) on delete cascade,
  variant_kind text not null check (variant_kind in ('shared_preview', 'thumbnail', 'poster', 'text_extract')),
  object_key text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  gps_stripped boolean not null default false,
  created_at timestamptz not null default now(),
  unique (asset_id, variant_kind)
);

create table message_attachments (
  message_id uuid not null references messages(id) on delete cascade,
  asset_id uuid not null references media_assets(id) on delete restrict,
  linked_by uuid not null references users(id),
  position integer not null default 0 check (position >= 0),
  caption text not null default '',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (message_id, asset_id)
);

create index message_attachments_asset_idx on message_attachments(asset_id, created_at desc)
  where revoked_at is null;

create table media_grants (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references media_assets(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  grantee_id uuid not null references users(id) on delete cascade,
  granted_by uuid not null references users(id),
  can_preview boolean not null default true,
  can_download boolean not null default false,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text,
  unique (asset_id, message_id, grantee_id)
);

create index media_grants_viewer_idx on media_grants(grantee_id, asset_id, created_at desc)
  where revoked_at is null;
create index media_grants_message_idx on media_grants(message_id, grantee_id)
  where revoked_at is null;

create table media_albums (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  owner_id uuid not null references users(id) on delete cascade,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (char_length(name) between 1 and 80),
  check (char_length(description) <= 500)
);

create index media_albums_owner_idx on media_albums(owner_id, updated_at desc, id desc)
  where deleted_at is null;

create table media_album_items (
  album_id uuid not null references media_albums(id) on delete cascade,
  asset_id uuid not null references media_assets(id) on delete cascade,
  added_by uuid not null references users(id),
  sort_order integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (album_id, asset_id)
);

create table media_processing_events (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid references media_upload_sessions(id) on delete set null,
  asset_id uuid references media_assets(id) on delete cascade,
  stage text not null check (stage in ('assemble', 'integrity', 'mime', 'malware', 'metadata', 'variant', 'complete')),
  status text not null check (status in ('started', 'succeeded', 'blocked', 'failed')),
  code text,
  created_at timestamptz not null default now(),
  check (upload_id is not null or asset_id is not null)
);

create index media_processing_events_asset_idx on media_processing_events(asset_id, created_at desc)
  where asset_id is not null;

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
  organization_id uuid not null references organizations(id) on delete cascade,
  space_id uuid references conversation_spaces(id) on delete set null,
  created_by uuid not null references users(id) on delete restrict,
  title text not null,
  description text not null default '',
  location text not null default '',
  visibility text not null check (visibility in ('private', 'attendees', 'space')),
  starts_local timestamp without time zone not null,
  ends_local timestamp without time zone not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  all_day boolean not null default false,
  recurrence_rule text,
  recurrence_json jsonb not null default '{}',
  recurrence_ends_at timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  version integer not null default 1 check (version > 0),
  cancellation_reason text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_local > starts_local),
  check (ends_at > starts_at),
  check (jsonb_typeof(recurrence_json) = 'object')
);

create table event_attendees (
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  invited_by uuid not null references users(id) on delete restrict,
  invitation_source text not null check (invitation_source in ('explicit', 'space_snapshot')),
  response_status text not null default 'needs_action'
    check (response_status in ('needs_action', 'accepted', 'declined', 'tentative')),
  invited_at timestamptz not null default now(),
  responded_at timestamptz,
  revoked_at timestamptz,
  primary key (event_id, user_id)
);

create index event_attendees_viewer_window_idx
  on event_attendees(user_id, event_id) where revoked_at is null;

create table event_reminders (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  offset_minutes integer not null check (offset_minutes between 0 and 10080),
  created_at timestamptz not null default now(),
  unique (event_id, offset_minutes)
);

create table event_reminder_receipts (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references event_reminders(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  occurrence_start_at timestamptz not null,
  trigger_at timestamptz not null,
  status text not null check (status in ('pending', 'dismissed')),
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reminder_id, user_id, occurrence_start_at)
);

create table call_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  space_id uuid not null references conversation_spaces(id) on delete cascade,
  created_by uuid not null references users(id),
  call_type text not null check (call_type in ('voice', 'video')),
  provider text not null default 'livekit' check (provider = 'livekit'),
  provider_room_name text not null unique,
  session_kind text not null default 'ad_hoc' check (session_kind in ('ad_hoc', 'scheduled_meeting', 'broadcast')),
  event_id uuid references events(id) on delete restrict,
  event_version integer,
  occurrence_starts_at timestamptz,
  occurrence_ends_at timestamptz,
  lobby_opens_at timestamptz,
  lobby_opened_at timestamptz,
  status text not null check (status in (
    'scheduled', 'starting', 'lobby_open', 'ringing', 'active',
    'ended', 'cancelled', 'failed', 'expired'
  )),
  version integer not null default 1 check (version > 0),
  expires_at timestamptz not null,
  started_at timestamptz,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status in ('ended', 'cancelled', 'failed', 'expired')) = (ended_at is not null)),
  check (
    (session_kind in ('ad_hoc', 'broadcast')
      and event_id is null and event_version is null
      and occurrence_starts_at is null and occurrence_ends_at is null
      and lobby_opens_at is null and lobby_opened_at is null)
    or
    (session_kind = 'scheduled_meeting'
      and event_id is not null and event_version is not null
      and occurrence_starts_at is not null and occurrence_ends_at is not null
      and lobby_opens_at is not null and occurrence_ends_at > occurrence_starts_at
      and lobby_opens_at < occurrence_ends_at and expires_at > occurrence_ends_at)
  )
);

create unique index call_sessions_event_occurrence_meeting_idx
  on call_sessions(event_id, occurrence_starts_at)
  where session_kind = 'scheduled_meeting';

create table call_participants (
  call_session_id uuid not null references call_sessions(id) on delete cascade,
  user_id uuid not null references users(id),
  role text not null check (role in ('host', 'participant', 'cohost', 'speaker', 'attendee', 'viewer')),
  status text not null check (status in (
    'invited', 'waiting', 'admitted', 'connecting', 'joined',
    'declined', 'left', 'removed', 'missed'
  )),
  provider_identity text not null unique,
  can_publish_audio boolean not null default true,
  can_publish_video boolean not null default false,
  screen_share_status text not null default 'off' check (screen_share_status in ('off', 'starting', 'active')),
  screen_share_requested_at timestamptz,
  screen_share_started_at timestamptz,
  screen_share_ended_at timestamptz,
  event_response_status text check (event_response_status is null or event_response_status in ('needs_action', 'accepted', 'declined', 'tentative')),
  token_version integer not null default 1 check (token_version > 0),
  invited_at timestamptz not null default now(),
  waiting_at timestamptz,
  admitted_at timestamptz,
  admitted_by uuid references users(id),
  connecting_at timestamptz,
  joined_at timestamptz,
  left_at timestamptz,
  declined_at timestamptz,
  role_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (call_session_id, user_id),
  check (screen_share_status = 'off' or screen_share_requested_at is not null)
);

create index call_participants_user_status_idx
  on call_participants(user_id, status, invited_at desc);

create index call_participants_meeting_moderation_idx
  on call_participants(call_session_id, role, status, waiting_at)
  where role in ('host', 'cohost') or status = 'waiting';

create unique index call_participants_one_screen_share_idx
  on call_participants(call_session_id)
  where screen_share_status in ('starting', 'active');

create index call_participants_screen_share_status_idx
  on call_participants(call_session_id, screen_share_status)
  where screen_share_status in ('starting', 'active');

create table call_events (
  id uuid primary key default gen_random_uuid(),
  call_session_id uuid not null references call_sessions(id) on delete cascade,
  actor_id uuid references users(id),
  participant_id uuid references users(id),
  event_type text not null,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table call_recordings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  call_session_id uuid not null references call_sessions(id) on delete cascade,
  requested_by uuid not null references users(id),
  started_by uuid references users(id),
  stop_requested_by uuid references users(id),
  status text not null check (status in (
    'consent_pending', 'consent_denied', 'consent_granted', 'starting',
    'recording', 'stopping', 'processing', 'ready', 'failed', 'aborted'
  )),
  policy_version text not null,
  recording_mode text not null default 'room_composite' check (recording_mode = 'room_composite'),
  layout text not null default 'grid' check (layout in ('grid', 'speaker')),
  output_format text not null default 'mp4' check (output_format = 'mp4'),
  output_object_key text not null unique,
  provider_egress_id text unique,
  provider_status text check (provider_status is null or provider_status in (
    'starting', 'active', 'ending', 'complete', 'failed', 'aborted', 'limit_reached'
  )),
  provider_recovery_checked_at timestamptz,
  consent_snapshot_json jsonb not null default '{}',
  failure_code text,
  stop_reason text,
  output_size_bytes bigint check (output_size_bytes is null or output_size_bytes >= 0),
  output_duration_seconds double precision check (output_duration_seconds is null or output_duration_seconds >= 0),
  requested_at timestamptz not null default now(),
  consent_completed_at timestamptz,
  started_at timestamptz,
  stop_requested_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (char_length(policy_version) between 1 and 80),
  check (output_object_key ~ '^recordings/[0-9a-f-]+/[0-9a-f-]+/[0-9a-f-]+[.]mp4$'),
  check (provider_egress_id is null or char_length(provider_egress_id) between 1 and 255),
  check (failure_code is null or char_length(failure_code) between 1 and 80),
  check (stop_reason is null or stop_reason in (
    'host_stopped', 'consent_revoked', 'session_ended', 'provider_failed'
  ))
);

create table call_recording_participants (
  recording_id uuid not null references call_recordings(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  participant_role text not null check (participant_role in ('host', 'participant', 'cohost', 'speaker', 'attendee')),
  consent_status text not null default 'pending' check (consent_status in ('pending', 'granted', 'denied', 'revoked')),
  consent_record_id uuid references consent_records(id) on delete set null,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (recording_id, user_id),
  check (
    (consent_status = 'pending' and consent_record_id is null and responded_at is null) or
    (consent_status <> 'pending' and consent_record_id is not null and responded_at is not null)
  )
);

create unique index call_recordings_one_pending_or_active_idx
  on call_recordings(call_session_id)
  where status in ('consent_pending', 'consent_granted', 'starting', 'recording', 'stopping');

create index call_recordings_session_timeline_idx
  on call_recordings(call_session_id, requested_at desc, id desc);

create index call_recordings_provider_status_idx
  on call_recordings(status, updated_at)
  where status in ('starting', 'recording', 'stopping', 'processing');

create index call_recordings_provider_recovery_idx
  on call_recordings(provider_recovery_checked_at, updated_at)
  where provider_egress_id is null and started_by is not null;

create index call_recording_participants_user_idx
  on call_recording_participants(user_id, created_at desc);

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
  check (
    (status = 'blocked' and blocked_by is not null and blocked_at is not null)
    or
    (status <> 'blocked' and blocked_by is null and blocked_at is null and block_reason is null)
  )
);

create index channel_subscriptions_user_status_idx
  on channel_subscriptions(user_id, status, updated_at desc);

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
  check (expected_end_at > scheduled_for),
  check (expected_end_at <= scheduled_for + interval '12 hours'),
  check ((status in ('ended', 'cancelled', 'failed')) = (ended_at is not null))
);

create unique index broadcast_sessions_one_live_channel_idx
  on broadcast_sessions(channel_id)
  where status in ('starting', 'live');

create index broadcast_sessions_channel_schedule_idx
  on broadcast_sessions(channel_id, scheduled_for desc, id desc);

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
  check (char_length(body) between 1 and 2000)
);

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
  unique (broadcast_session_id, sender_id, client_reaction_id)
);

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
  check (target_user_id is not null or target_message_id is not null)
);

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
  check (
    (status = 'ready' and media_asset_id is not null and available_at is not null)
    or
    (status <> 'ready' and media_asset_id is null and available_at is null)
  )
);

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
  created_at timestamptz not null default now()
);

create table ai_model_configs (
  id uuid primary key default gen_random_uuid(),
  capability text not null check (capability in (
    'assistant', 'summary', 'stt', 'tts_standard', 'tts_voice_profile', 'avatar'
  )),
  provider text not null,
  model_family text not null,
  model_name text not null,
  minimum_version text,
  deployment_mode text not null check (deployment_mode in ('local', 'private_server', 'managed_api')),
  settings_json jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (capability, provider, model_name),
  check (
    capability not in ('assistant', 'summary')
    or (model_family = 'qwen' and minimum_version in ('3.5', '3.6'))
  )
);

create table ai_workers (
  worker_id text primary key,
  capabilities text[] not null,
  protocol_version integer not null default 1 check (protocol_version = 1),
  metadata_json jsonb not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table ai_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  requested_by uuid not null references users(id) on delete cascade,
  model_config_id uuid not null references ai_model_configs(id),
  job_type text not null check (job_type in (
    'stt', 'tts', 'summary', 'avatar_generation',
    'voice_profile_enrollment', 'voice_profile_delete'
  )),
  input_asset_id uuid references media_assets(id) on delete restrict,
  space_id uuid references conversation_spaces(id) on delete cascade,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  priority smallint not null default 50 check (priority between 0 and 100),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  fencing_token bigint not null default 0,
  lease_owner text references ai_workers(worker_id) on delete set null,
  lease_expires_at timestamptz,
  progress smallint not null default 0 check (progress between 0 and 100),
  input_json jsonb not null default '{}',
  result_json jsonb,
  error_code text,
  error_message text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  unique (requested_by, idempotency_key),
  check (
    (status = 'running' and lease_owner is not null and lease_expires_at is not null)
    or (status <> 'running' and lease_owner is null and lease_expires_at is null)
  )
);

create index ai_jobs_worker_idx on ai_jobs(status, available_at, priority desc, created_at, id)
  where status in ('queued', 'running');
create index ai_jobs_requester_idx on ai_jobs(requested_by, created_at desc, id desc);

create table ai_job_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references ai_jobs(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  fencing_token bigint not null check (fencing_token > 0),
  worker_id text not null,
  status text not null check (status in ('running', 'succeeded', 'failed', 'timed_out', 'cancelled')),
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (job_id, attempt_number),
  unique (job_id, fencing_token)
);

create table ai_job_dispatches (
  id bigserial primary key,
  job_id uuid not null references ai_jobs(id) on delete cascade,
  transport text not null check (transport in ('redis_stream', 'database_poll')),
  status text not null check (status in ('pending', 'published', 'failed')),
  attempt_count integer not null default 0,
  last_error_code text,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create index ai_job_dispatches_pending_idx on ai_job_dispatches(created_at, id)
  where status in ('pending', 'failed');

create table ai_summary_inputs (
  job_id uuid not null references ai_jobs(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  position integer not null check (position >= 0),
  primary key (job_id, message_id),
  unique (job_id, position)
);

create table voice_transcripts (
  id uuid primary key default gen_random_uuid(),
  ai_job_id uuid not null unique references ai_jobs(id) on delete cascade,
  source_asset_id uuid not null references media_assets(id) on delete restrict,
  language text not null,
  draft_text text not null,
  edited_text text,
  segments_json jsonb not null default '[]',
  review_status text not null check (review_status in ('ai_draft', 'sending', 'reviewed', 'rejected')),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  send_client_message_id text,
  approved_message_id uuid unique references messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table voice_profile_consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  subject_user_id uuid not null references users(id) on delete cascade,
  reference_asset_id uuid not null references media_assets(id) on delete restrict,
  purpose text not null check (purpose in ('personal_tts')),
  policy_version text not null,
  disclosure_version text not null,
  consent_digest text not null,
  status text not null check (status in ('active', 'revoked', 'expired')),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table voice_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  subject_user_id uuid not null references users(id) on delete cascade,
  created_by uuid not null references users(id),
  reference_asset_id uuid not null references media_assets(id) on delete restrict,
  model_config_id uuid not null references ai_model_configs(id),
  consent_id uuid not null unique references voice_profile_consents(id) on delete restrict,
  enrollment_job_id uuid unique references ai_jobs(id) on delete set null,
  encrypted_embedding_key text,
  status text not null check (status in ('pending', 'active', 'revoked', 'deleting', 'deleted')),
  watermark_required boolean not null default true,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  deleted_at timestamptz
);

create table tts_assets (
  id uuid primary key default gen_random_uuid(),
  ai_job_id uuid not null unique references ai_jobs(id) on delete cascade,
  requested_by uuid not null references users(id) on delete cascade,
  voice_profile_id uuid references voice_profiles(id) on delete restrict,
  model_config_id uuid not null references ai_model_configs(id),
  text_hash text not null,
  settings_hash text not null,
  media_asset_id uuid not null unique references media_assets(id) on delete restrict,
  duration_ms integer,
  watermarked boolean not null default false,
  created_at timestamptz not null default now(),
  unique nulls not distinct (requested_by, text_hash, settings_hash, voice_profile_id, model_config_id)
);

create table avatar_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  source_asset_id uuid references media_assets(id) on delete set null,
  display_asset_id uuid references media_assets(id) on delete set null,
  generation_job_id uuid unique references ai_jobs(id) on delete set null,
  avatar_type text not null check (avatar_type in ('preset', 'photo', 'caricature', 'animated_2d')),
  style text not null default 'work-friendly',
  animation_profile_json jsonb not null default '{}',
  ai_generated boolean not null default false,
  consent_to_store_source boolean not null default false,
  status text not null check (status in ('pending', 'active', 'rejected', 'deleted')),
  selected_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table media_assets
  add constraint media_assets_generated_job_fk
  foreign key (generated_by_job_id) references ai_jobs(id) on delete set null;

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
  status text not null check (status in (
    'requested', 'approved', 'active', 'paused', 'ended', 'declined', 'revoked', 'expired', 'failed'
  )),
  control_epoch bigint not null default 1,
  next_command_sequence bigint not null default 1,
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
  check ('screen_view' = any(requested_scopes))
);

create table remote_support_consents (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  subject_user_id uuid not null references users(id),
  scope text not null check (scope in ('screen_view', 'remote_control', 'clipboard', 'file_transfer')),
  decision text not null check (decision in ('pending', 'granted', 'denied', 'revoked')),
  policy_version text not null,
  disclosure_digest text not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  unique (session_id, scope)
);

create table remote_support_agent_credentials (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  target_user_id uuid not null references users(id),
  credential_kind text not null check (credential_kind in ('activation', 'agent')),
  token_digest bytea not null unique,
  control_epoch bigint not null,
  agent_mode text not null check (agent_mode in ('dry_run', 'signed_native')),
  agent_instance_id text,
  status text not null check (status in ('active', 'consumed', 'revoked', 'expired')),
  issued_at timestamptz not null default now(),
  used_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table remote_support_commands (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  requested_by uuid not null references users(id),
  client_command_id text not null,
  request_hash text not null,
  control_epoch bigint not null,
  sequence bigint not null,
  command_kind text not null check (command_kind in ('pointer_move', 'pointer_button', 'wheel', 'key')),
  payload_json jsonb not null,
  status text not null check (status in ('queued', 'claimed', 'executed', 'simulated', 'rejected', 'expired', 'cancelled')),
  claimed_by uuid references remote_support_agent_credentials(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  result_code text,
  unique (session_id, control_epoch, sequence),
  unique (session_id, requested_by, client_command_id)
);

create table remote_support_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references remote_support_sessions(id) on delete cascade,
  actor_id uuid references users(id),
  agent_instance_id text,
  event_type text not null,
  metadata_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

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
