create unique index data_lifecycle_jobs_one_active_export_expiry_idx
  on data_lifecycle_jobs (organization_id)
  where job_type = 'audit_export_expiry' and dry_run = false
    and status in ('requested', 'approved', 'running', 'blocked', 'failed');
