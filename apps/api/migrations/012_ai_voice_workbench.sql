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
    or (model_family = 'qwen' and minimum_version is not null and minimum_version in ('3.5', '3.6'))
  )
);

create table ai_workers (
  worker_id text primary key,
  capabilities text[] not null,
  protocol_version integer not null default 1 check (protocol_version = 1),
  metadata_json jsonb not null default '{}',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check (char_length(worker_id) between 3 and 120)
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
  fencing_token bigint not null default 0 check (fencing_token >= 0),
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
  check (char_length(idempotency_key) between 8 and 160),
  check (char_length(request_hash) = 64),
  check (
    (status = 'running' and lease_owner is not null and lease_expires_at is not null)
    or (status <> 'running' and lease_owner is null and lease_expires_at is null)
  ),
  check (job_type <> 'stt' or input_asset_id is not null),
  check (job_type <> 'summary' or space_id is not null),
  check (job_type not in ('avatar_generation', 'voice_profile_enrollment') or input_asset_id is not null)
);

create index ai_jobs_worker_idx
  on ai_jobs(status, available_at, priority desc, created_at, id)
  where status in ('queued', 'running');

create index ai_jobs_requester_idx
  on ai_jobs(requested_by, created_at desc, id desc);

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

create index ai_job_dispatches_pending_idx
  on ai_job_dispatches(created_at, id)
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
  review_status text not null default 'ai_draft' check (review_status in ('ai_draft', 'sending', 'reviewed', 'rejected')),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  send_client_message_id text,
  approved_message_id uuid unique references messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(language) between 2 and 24),
  check (char_length(draft_text) between 1 and 10000),
  check (edited_text is null or char_length(edited_text) between 1 and 10000),
  check (send_client_message_id is null or char_length(send_client_message_id) between 8 and 160),
  check (review_status <> 'reviewed' or (reviewed_by is not null and reviewed_at is not null and approved_message_id is not null)),
  check (review_status <> 'rejected' or (reviewed_by is not null and reviewed_at is not null))
);

create table voice_profile_consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  subject_user_id uuid not null references users(id) on delete cascade,
  reference_asset_id uuid not null references media_assets(id) on delete restrict,
  purpose text not null check (purpose in ('personal_tts')),
  policy_version text not null,
  disclosure_version text not null,
  consent_digest text not null check (char_length(consent_digest) = 64),
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > granted_at),
  check ((status = 'revoked') = (revoked_at is not null))
);

create index voice_profile_consents_subject_idx
  on voice_profile_consents(subject_user_id, status, expires_at desc);

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
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked', 'deleting', 'deleted')),
  watermark_required boolean not null default true,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  deleted_at timestamptz,
  check (created_by = subject_user_id),
  check (status <> 'active' or (encrypted_embedding_key is not null and activated_at is not null)),
  check (status <> 'deleted' or deleted_at is not null)
);

create unique index voice_profiles_one_live_subject_idx
  on voice_profiles(subject_user_id)
  where status in ('pending', 'active');

create table tts_assets (
  id uuid primary key default gen_random_uuid(),
  ai_job_id uuid not null unique references ai_jobs(id) on delete cascade,
  requested_by uuid not null references users(id) on delete cascade,
  voice_profile_id uuid references voice_profiles(id) on delete restrict,
  model_config_id uuid not null references ai_model_configs(id),
  text_hash text not null check (char_length(text_hash) = 64),
  settings_hash text not null check (char_length(settings_hash) = 64),
  media_asset_id uuid not null unique references media_assets(id) on delete restrict,
  watermarked boolean not null,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  unique nulls not distinct (requested_by, text_hash, settings_hash, voice_profile_id, model_config_id),
  check (voice_profile_id is null or watermarked)
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
  status text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'deleted')),
  selected_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (not ai_generated or generation_job_id is not null)
);

alter table media_assets drop constraint if exists media_assets_source_check;
alter table media_assets
  add constraint media_assets_source_check
  check (source in ('file_upload', 'screen_capture', 'ai_generated'));
alter table media_assets add column generated_by_job_id uuid references ai_jobs(id) on delete set null;
create unique index media_assets_generated_job_idx
  on media_assets(generated_by_job_id)
  where generated_by_job_id is not null;

insert into ai_model_configs (
  id, capability, provider, model_family, model_name, minimum_version, deployment_mode, settings_json
) values
  (
    '00000000-0000-4000-8000-000000000801', 'stt', 'faster-whisper', 'whisper',
    'large-v3-turbo', null, 'local', '{"vad":"silero-vad","compute":"auto","language":"auto"}'
  ),
  (
    '00000000-0000-4000-8000-000000000802', 'summary', 'qwen', 'qwen',
    'Qwen3.5-4B', '3.5', 'local', '{"structuredOutput":true,"draftLabel":true}'
  ),
  (
    '00000000-0000-4000-8000-000000000803', 'tts_standard', 'qwen', 'qwen3-tts',
    'Qwen3-TTS-12Hz-0.6B-CustomVoice', null, 'local', '{"language":"Korean","speaker":"Sohee","watermark":false}'
  ),
  (
    '00000000-0000-4000-8000-000000000804', 'tts_voice_profile', 'qwen', 'qwen3-tts',
    'Qwen3-TTS-12Hz-1.7B-Base', null, 'private_server', '{"watermark":true,"consentRequired":true}'
  ),
  (
    '00000000-0000-4000-8000-000000000805', 'avatar', 'adapter', 'provider-neutral',
    'consented-caricature-v1', null, 'private_server', '{"sourceConsentRequired":true,"aiLabel":true}'
  )
on conflict (id) do nothing;
