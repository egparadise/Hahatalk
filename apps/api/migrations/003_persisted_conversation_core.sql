create extension if not exists pg_trgm;

create table conversation_spaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
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

create index conversation_spaces_org_updated_idx
  on conversation_spaces(organization_id, updated_at desc)
  where archived_at is null;

create unique index conversation_spaces_default_hub_idx
  on conversation_spaces(organization_id)
  where type = 'hub' and archived_at is null and (settings_json ->> 'isDefault')::boolean is true;

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

create index space_memberships_user_idx
  on space_memberships(user_id, status, joined_at desc);

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
  unique (sender_id, client_message_id),
  check (char_length(client_message_id) between 8 and 160),
  check (char_length(body) <= 10000)
);

create table message_audiences (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  audience_type text not null check (audience_type in ('all', 'selected', 'private', 'role')),
  target_user_id uuid references users(id),
  target_role text check (target_role in ('owner', 'admin', 'member', 'guest', 'subscriber')),
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
  unique (message_id, recipient_id),
  check (confirmed_at is null or read_at is not null)
);

alter table space_memberships
  add constraint space_memberships_last_read_fk
  foreign key (last_read_message_id) references messages(id) on delete set null;

create index messages_space_timeline_idx
  on messages(space_id, created_at desc, id desc)
  where deleted_at is null;

create index messages_body_trgm_idx
  on messages using gin(body gin_trgm_ops)
  where deleted_at is null;

create index message_audiences_target_idx
  on message_audiences(target_user_id, message_id)
  where target_user_id is not null;

create index message_deliveries_recipient_idx
  on message_deliveries(recipient_id, created_at desc, message_id desc)
  where revoked_at is null;

create index message_deliveries_thread_idx
  on message_deliveries(thread_key, created_at desc, message_id desc)
  where revoked_at is null;

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

create index idempotency_keys_expiry_idx on idempotency_keys(expires_at);

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

create index outbox_events_unpublished_idx
  on outbox_events(created_at, id)
  where published_at is null;

insert into conversation_spaces (
  id, organization_id, type, name, owner_id, roster_visibility, settings_json, created_at, updated_at
) values
  (
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000001',
    'hub',
    '프로젝트 A 허브방',
    '00000000-0000-4000-8000-000000000101',
    'owner_only',
    '{"isDefault":true,"guestCanDownload":false,"readReportEnabled":true,"fileSharingEnabled":true,"publicAnnouncementsEnabled":true}',
    now() - interval '3 days',
    now() - interval '10 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000001',
    'open_group',
    '인비즈 업무 단체방',
    '00000000-0000-4000-8000-000000000101',
    'shared',
    '{"guestCanDownload":false,"readReportEnabled":true,"fileSharingEnabled":true,"publicAnnouncementsEnabled":false}',
    now() - interval '2 days',
    now() - interval '8 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000000203',
    '00000000-0000-4000-8000-000000000001',
    'direct',
    '업무 1:1',
    '00000000-0000-4000-8000-000000000101',
    'owner_only',
    '{"guestCanDownload":false,"readReportEnabled":true,"fileSharingEnabled":true,"publicAnnouncementsEnabled":false}',
    now() - interval '1 day',
    now() - interval '6 minutes'
  )
on conflict (id) do nothing;

insert into space_memberships (space_id, user_id, role, view_mode, status, joined_at)
values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'owner', 'owner_console', 'active', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000102', 'admin', 'direct_with_owner', 'active', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000103', 'member', 'direct_with_owner', 'active', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000104', 'guest', 'direct_with_owner', 'active', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000101', 'owner', 'shared_room', 'active', now() - interval '2 days'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000102', 'admin', 'shared_room', 'active', now() - interval '2 days'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000103', 'member', 'shared_room', 'active', now() - interval '2 days'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000101', 'owner', 'shared_room', 'active', now() - interval '1 day'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000102', 'member', 'shared_room', 'active', now() - interval '1 day')
on conflict (space_id, user_id) do nothing;

insert into hub_spokes (id, space_id, owner_id, participant_id)
values
  ('00000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000212', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000103'),
  ('00000000-0000-4000-8000-000000000213', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000104')
on conflict (space_id, participant_id) do nothing;

insert into messages (
  id, space_id, sender_id, client_message_id, message_type, delivery_mode, body, metadata_json, created_at
) values
  (
    '00000000-0000-4000-8000-000000000301',
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000101',
    'seed-hub-announcement-001',
    'text',
    'hub_announcement',
    '오늘 고객 미팅 자료와 체크리스트를 이 방에서 같이 봅시다.',
    '{"requiresConfirmation":true}',
    now() - interval '10 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000000302',
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000102',
    'seed-hub-reply-001',
    'text',
    'direct',
    '제안서 초안을 확인했습니다. 수정 의견을 정리하겠습니다.',
    '{}',
    now() - interval '8 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000000303',
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000101',
    'seed-hub-selected-001',
    'text',
    'hub_fanout',
    '미나님, 가격표는 내부 검토 후 고객에게 공개합시다.',
    '{}',
    now() - interval '6 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000000304',
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000103',
    'seed-open-group-001',
    'text',
    'shared',
    '오늘 업무 단체방 점검을 시작합니다.',
    '{}',
    now() - interval '4 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000000305',
    '00000000-0000-4000-8000-000000000203',
    '00000000-0000-4000-8000-000000000101',
    'seed-direct-001',
    'text',
    'direct',
    '미나님, Stage 3 대화 영속화 검토를 부탁드립니다.',
    '{}',
    now() - interval '2 minutes'
  )
on conflict (id) do nothing;

insert into message_audiences (id, message_id, audience_type, target_user_id)
values
  ('00000000-0000-4000-8000-000000000311', '00000000-0000-4000-8000-000000000301', 'all', null),
  ('00000000-0000-4000-8000-000000000312', '00000000-0000-4000-8000-000000000302', 'private', '00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000313', '00000000-0000-4000-8000-000000000303', 'selected', '00000000-0000-4000-8000-000000000102'),
  ('00000000-0000-4000-8000-000000000314', '00000000-0000-4000-8000-000000000304', 'all', null),
  ('00000000-0000-4000-8000-000000000315', '00000000-0000-4000-8000-000000000305', 'private', '00000000-0000-4000-8000-000000000102')
on conflict (id) do nothing;

insert into message_deliveries (
  id, message_id, recipient_id, thread_key, status, delivered_at, read_at, created_at
) values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201:owner-console', 'delivered', now() - interval '10 minutes', now() - interval '10 minutes', now() - interval '10 minutes'),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000201:spoke:user-mina', 'delivered', now() - interval '10 minutes', now() - interval '9 minutes', now() - interval '10 minutes'),
  ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000201:spoke:user-jun', 'delivered', now() - interval '10 minutes', null, now() - interval '10 minutes'),
  ('00000000-0000-4000-8000-000000000404', '00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000201:spoke:guest-hana', 'delivered', now() - interval '10 minutes', null, now() - interval '10 minutes'),
  ('00000000-0000-4000-8000-000000000405', '00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000201:spoke:user-mina', 'delivered', now() - interval '8 minutes', now() - interval '8 minutes', now() - interval '8 minutes'),
  ('00000000-0000-4000-8000-000000000406', '00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201:spoke:user-mina', 'delivered', now() - interval '8 minutes', now() - interval '7 minutes', now() - interval '8 minutes'),
  ('00000000-0000-4000-8000-000000000407', '00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201:owner-console', 'delivered', now() - interval '6 minutes', now() - interval '6 minutes', now() - interval '6 minutes'),
  ('00000000-0000-4000-8000-000000000408', '00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000201:spoke:user-mina', 'delivered', now() - interval '6 minutes', null, now() - interval '6 minutes'),
  ('00000000-0000-4000-8000-000000000409', '00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000202:shared', 'delivered', now() - interval '4 minutes', null, now() - interval '4 minutes'),
  ('00000000-0000-4000-8000-000000000410', '00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000202:shared', 'delivered', now() - interval '4 minutes', null, now() - interval '4 minutes'),
  ('00000000-0000-4000-8000-000000000411', '00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000202:shared', 'delivered', now() - interval '4 minutes', now() - interval '4 minutes', now() - interval '4 minutes'),
  ('00000000-0000-4000-8000-000000000412', '00000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000203:shared', 'delivered', now() - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes'),
  ('00000000-0000-4000-8000-000000000413', '00000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000203:shared', 'delivered', now() - interval '2 minutes', null, now() - interval '2 minutes')
on conflict (message_id, recipient_id) do nothing;
