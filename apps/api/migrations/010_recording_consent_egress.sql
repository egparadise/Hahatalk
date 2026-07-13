alter table consent_records
  drop constraint consent_records_consent_type_check;

alter table consent_records
  add constraint consent_records_consent_type_check check (consent_type in (
    'terms', 'privacy', 'group_join', 'screen_share', 'remote_view', 'remote_control',
    'recording', 'ai_transcript', 'voice_profile', 'avatar_source_retention', 'external_share'
  )),
  add column scope_type text,
  add column scope_id uuid,
  add column expires_at timestamptz,
  add constraint consent_records_scope_pair_check check (
    (scope_type is null and scope_id is null) or
    (scope_type is not null and scope_id is not null)
  );

create index consent_records_scope_idx
  on consent_records(scope_type, scope_id, consent_type, created_at desc)
  where scope_type is not null and scope_id is not null;

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
