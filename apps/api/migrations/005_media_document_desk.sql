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
  source text not null check (source in ('file_upload', 'screen_capture')),
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

create index media_upload_sessions_owner_status_idx
  on media_upload_sessions(owner_id, status, updated_at desc);

create index media_upload_sessions_expiry_idx
  on media_upload_sessions(expires_at)
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

create index message_attachments_asset_idx
  on message_attachments(asset_id, created_at desc)
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

create index media_grants_viewer_idx
  on media_grants(grantee_id, asset_id, created_at desc)
  where revoked_at is null;

create index media_grants_message_idx
  on media_grants(message_id, grantee_id)
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

create index media_albums_owner_idx
  on media_albums(owner_id, updated_at desc, id desc)
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

create index media_processing_events_asset_idx
  on media_processing_events(asset_id, created_at desc)
  where asset_id is not null;
