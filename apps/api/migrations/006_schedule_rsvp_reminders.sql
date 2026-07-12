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
  check (char_length(title) between 1 and 160),
  check (char_length(description) <= 4000),
  check (char_length(location) <= 200),
  check (char_length(timezone) between 1 and 120),
  check (ends_local > starts_local),
  check (ends_at > starts_at),
  check (jsonb_typeof(recurrence_json) = 'object'),
  check (
    (recurrence_rule is null and recurrence_json = '{}'::jsonb and recurrence_ends_at is null)
    or (recurrence_rule is not null and recurrence_json <> '{}'::jsonb and recurrence_ends_at is not null)
  ),
  check (
    (status = 'scheduled' and cancelled_at is null and cancellation_reason is null)
    or (status = 'cancelled' and cancelled_at is not null)
  )
);

create index events_creator_window_idx
  on events(created_by, starts_at, id)
  where status = 'scheduled';

create index events_organization_window_idx
  on events(organization_id, starts_at, id)
  where status = 'scheduled';

create index events_space_window_idx
  on events(space_id, starts_at, id)
  where space_id is not null and status = 'scheduled';

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
  primary key (event_id, user_id),
  check (
    (response_status = 'needs_action' and responded_at is null)
    or (response_status <> 'needs_action' and responded_at is not null)
  )
);

create index event_attendees_viewer_window_idx
  on event_attendees(user_id, event_id)
  where revoked_at is null;

create index event_attendees_event_active_idx
  on event_attendees(event_id, response_status, invited_at)
  where revoked_at is null;

create table event_reminders (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  offset_minutes integer not null check (offset_minutes between 0 and 10080),
  created_at timestamptz not null default now(),
  unique (event_id, offset_minutes)
);

create index event_reminders_event_idx on event_reminders(event_id, offset_minutes);

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
  unique (reminder_id, user_id, occurrence_start_at),
  check (
    (status = 'pending' and dismissed_at is null)
    or (status = 'dismissed' and dismissed_at is not null)
  )
);

create index event_reminder_receipts_viewer_idx
  on event_reminder_receipts(user_id, trigger_at, occurrence_start_at)
  where status = 'pending';
