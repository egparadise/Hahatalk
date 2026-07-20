alter table ai_jobs
  drop constraint if exists ai_jobs_job_type_check;

alter table ai_jobs
  add constraint ai_jobs_job_type_check check (job_type in (
    'assistant', 'stt', 'tts', 'summary', 'avatar_generation',
    'voice_profile_enrollment', 'voice_profile_delete'
  ));

insert into ai_model_configs (
  capability, provider, model_family, model_name, minimum_version,
  deployment_mode, settings_json, enabled
) values (
  'assistant',
  'ollama',
  'qwen',
  'Qwen3.5-4B',
  '3.5',
  'local',
  '{"baseUrl":"http://127.0.0.1:11434","ollamaModel":"qwen3.5:4b","contextMessages":24}',
  true
)
on conflict (capability, provider, model_name) do update
set minimum_version = excluded.minimum_version,
    deployment_mode = excluded.deployment_mode,
    settings_json = excluded.settings_json,
    enabled = true,
    updated_at = now();

insert into users (id, public_id, email, display_name, status, account_claimed_at)
values (
  '00000000-0000-4000-8000-000000000105',
  'assistant-hahatalk-ai',
  'assistant@local.hahatalk',
  'HahaTalk AI',
  'active',
  now()
)
on conflict (id) do update
set display_name = excluded.display_name,
    status = 'active',
    updated_at = now();

insert into organization_memberships (organization_id, user_id, role, status, joined_at)
values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000105',
  'member',
  'active',
  now()
)
on conflict (organization_id, user_id) do update
set role = 'member', status = 'active', joined_at = coalesce(organization_memberships.joined_at, now());

insert into profiles (user_id, public_profile_json)
values (
  '00000000-0000-4000-8000-000000000105',
  '{"characterId":"char-focus-maker","accountKind":"local_ai"}'
)
on conflict (user_id) do update
set public_profile_json = excluded.public_profile_json,
    updated_at = now();

create unique index conversation_spaces_local_assistant_idx
  on conversation_spaces (organization_id)
  where archived_at is null and settings_json ->> 'assistantKind' = 'local_ollama';

insert into conversation_spaces (
  id, organization_id, type, name, owner_id, roster_visibility, settings_json
) values (
  '00000000-0000-4000-8000-000000000204',
  '00000000-0000-4000-8000-000000000001',
  'direct',
  'HahaTalk AI',
  '00000000-0000-4000-8000-000000000101',
  'owner_only',
  '{"assistantKind":"local_ollama","assistant":{"provider":"ollama","model":"Qwen3.5-4B","local":true},"fileSharingEnabled":false,"readReportEnabled":false,"guestCanDownload":false,"publicAnnouncementsEnabled":false}'
)
on conflict (id) do update
set name = excluded.name,
    settings_json = excluded.settings_json,
    archived_at = null,
    updated_at = now();

insert into space_memberships (space_id, user_id, role, view_mode, status, joined_at)
values
  (
    '00000000-0000-4000-8000-000000000204',
    '00000000-0000-4000-8000-000000000101',
    'owner',
    'shared_room',
    'active',
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000204',
    '00000000-0000-4000-8000-000000000105',
    'member',
    'shared_room',
    'active',
    now()
  )
on conflict (space_id, user_id) do update
set role = excluded.role,
    view_mode = excluded.view_mode,
    status = 'active';

delete from messages
where client_message_id like 'seed-%';
