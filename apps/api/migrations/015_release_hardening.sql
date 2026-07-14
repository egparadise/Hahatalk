create table rate_limit_buckets (
  key_hash bytea primary key check (octet_length(key_hash) = 32),
  throttler_name text not null check (throttler_name ~ '^[a-z0-9_-]{1,64}$'),
  hit_count integer not null default 0 check (hit_count >= 0),
  window_expires_at timestamptz not null,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create index rate_limit_buckets_expiry_idx
  on rate_limit_buckets (greatest(window_expires_at, coalesce(blocked_until, window_expires_at)));

create table audit_export_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  requested_by uuid not null references users(id),
  idempotency_digest bytea not null check (octet_length(idempotency_digest) = 32),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed', 'expired')),
  from_at timestamptz not null,
  to_at timestamptz not null,
  action_prefix text check (action_prefix is null or action_prefix ~ '^[a-z0-9_.-]{1,80}$'),
  object_key text,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  record_count integer check (record_count is null or record_count >= 0),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9_.-]{1,80}$'),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, requested_by, idempotency_digest),
  check (to_at > from_at and to_at - from_at <= interval '366 days'),
  check ((status = 'completed' and object_key is not null and content_sha256 is not null and expires_at is not null)
    or (status in ('queued', 'processing', 'failed') and object_key is null and content_sha256 is null)
    or status = 'expired')
);

create index audit_export_jobs_org_created_idx
  on audit_export_jobs (organization_id, created_at desc);
create index audit_export_jobs_expiry_idx
  on audit_export_jobs (expires_at) where status = 'completed';

create table retention_policies (
  organization_id uuid not null references organizations(id) on delete cascade,
  data_class text not null
    check (data_class in ('operational_transient', 'audit_export', 'message', 'media', 'ai', 'user_account')),
  retain_days integer not null check (retain_days between 1 and 3650),
  enabled boolean not null default true,
  version integer not null default 1 check (version > 0),
  changed_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, data_class)
);

create table legal_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid not null references users(id),
  scope_type text not null check (scope_type in ('organization', 'user', 'conversation', 'media')),
  scope_id uuid,
  data_class text not null
    check (data_class in ('all', 'operational_transient', 'audit_export', 'message', 'media', 'ai', 'user_account')),
  reason_code text not null check (reason_code ~ '^[a-z0-9_.-]{2,80}$'),
  status text not null default 'active' check (status in ('active', 'released')),
  released_by uuid references users(id),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  check ((scope_type = 'organization' and scope_id is null) or (scope_type <> 'organization' and scope_id is not null)),
  check ((status = 'active' and released_by is null and released_at is null)
    or (status = 'released' and released_by is not null and released_at is not null))
);

create unique index legal_holds_active_scope_idx
  on legal_holds (
    organization_id,
    scope_type,
    coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    data_class
  ) where status = 'active';

create table data_lifecycle_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  requested_by uuid not null references users(id),
  approved_by uuid references users(id),
  idempotency_digest bytea not null check (octet_length(idempotency_digest) = 32),
  job_type text not null
    check (job_type in ('operational_cleanup', 'audit_export_expiry', 'user_deletion')),
  data_class text not null
    check (data_class in ('operational_transient', 'audit_export', 'user_account')),
  target_user_id uuid references users(id),
  dry_run boolean not null default true,
  cutoff_at timestamptz,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'running', 'completed', 'blocked', 'failed', 'cancelled')),
  preview_json jsonb not null default '{}',
  result_json jsonb not null default '{}',
  legal_hold_id uuid references legal_holds(id),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z0-9_.-]{1,80}$'),
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, requested_by, idempotency_digest),
  check ((job_type = 'user_deletion' and data_class = 'user_account' and target_user_id is not null and cutoff_at is null)
    or (job_type <> 'user_deletion' and target_user_id is null and cutoff_at is not null)),
  check (approved_by is null or approved_by <> requested_by),
  check ((approved_by is null and approved_at is null) or (approved_by is not null and approved_at is not null))
);

create index data_lifecycle_jobs_org_created_idx
  on data_lifecycle_jobs (organization_id, created_at desc);
create index data_lifecycle_jobs_status_idx
  on data_lifecycle_jobs (status, created_at) where status in ('requested', 'approved', 'running');

create table release_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid not null references users(id),
  version text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$'),
  git_sha text not null check (git_sha ~ '^[a-f0-9]{40}$'),
  schema_version text not null check (schema_version ~ '^[0-9]{3}_[a-z0-9_-]+\.sql$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_sha256 text check (artifact_sha256 is null or artifact_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'draft'
    check (status in ('draft', 'candidate', 'approved', 'rejected', 'rolled_back')),
  rollout_percent integer not null default 0 check (rollout_percent between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, version, git_sha)
);

create table release_gate_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  candidate_id uuid not null references release_candidates(id) on delete cascade,
  recorded_by uuid not null references users(id),
  gate_name text not null check (gate_name ~ '^[a-z0-9_.-]{2,80}$'),
  result text not null check (result in ('passed', 'failed', 'pending_external')),
  evidence_sha256 text check (evidence_sha256 is null or evidence_sha256 ~ '^[a-f0-9]{64}$'),
  detail_code text not null check (detail_code ~ '^[a-z0-9_.-]{2,80}$'),
  checked_at timestamptz not null default now(),
  unique (candidate_id, gate_name)
);

create index release_candidates_org_created_idx
  on release_candidates (organization_id, created_at desc);

alter table audit_export_jobs enable row level security;
alter table audit_export_jobs force row level security;
create policy audit_export_jobs_org_isolation on audit_export_jobs
  using (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid);

alter table retention_policies enable row level security;
alter table retention_policies force row level security;
create policy retention_policies_org_isolation on retention_policies
  using (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid);

alter table legal_holds enable row level security;
alter table legal_holds force row level security;
create policy legal_holds_org_isolation on legal_holds
  using (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid);

alter table data_lifecycle_jobs enable row level security;
alter table data_lifecycle_jobs force row level security;
create policy data_lifecycle_jobs_org_isolation on data_lifecycle_jobs
  using (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid);

alter table release_candidates enable row level security;
alter table release_candidates force row level security;
create policy release_candidates_org_isolation on release_candidates
  using (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid);

alter table release_gate_results enable row level security;
alter table release_gate_results force row level security;
create policy release_gate_results_org_isolation on release_gate_results
  using (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('hahatalk.organization_id', true), '')::uuid);
