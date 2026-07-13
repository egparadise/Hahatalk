alter table call_sessions
  add column session_kind text not null default 'ad_hoc',
  add column event_id uuid references events(id) on delete restrict,
  add column event_version integer,
  add column occurrence_starts_at timestamptz,
  add column occurrence_ends_at timestamptz,
  add column lobby_opens_at timestamptz,
  add column lobby_opened_at timestamptz;

alter table call_sessions drop constraint call_sessions_status_check;
alter table call_sessions add constraint call_sessions_status_check
  check (status in (
    'scheduled', 'starting', 'lobby_open', 'ringing', 'active',
    'ended', 'cancelled', 'failed', 'expired'
  ));

alter table call_sessions add constraint call_sessions_session_kind_check
  check (session_kind in ('ad_hoc', 'scheduled_meeting'));

alter table call_sessions add constraint call_sessions_schedule_link_check
  check (
    (session_kind = 'ad_hoc'
      and event_id is null
      and event_version is null
      and occurrence_starts_at is null
      and occurrence_ends_at is null
      and lobby_opens_at is null)
    or
    (session_kind = 'scheduled_meeting'
      and event_id is not null
      and event_version is not null
      and occurrence_starts_at is not null
      and occurrence_ends_at is not null
      and lobby_opens_at is not null
      and occurrence_ends_at > occurrence_starts_at
      and lobby_opens_at < occurrence_ends_at
      and expires_at > occurrence_ends_at)
  );

create unique index call_sessions_event_occurrence_meeting_idx
  on call_sessions(event_id, occurrence_starts_at)
  where session_kind = 'scheduled_meeting';

create index call_sessions_meeting_viewer_window_idx
  on call_sessions(organization_id, occurrence_starts_at, status)
  where session_kind = 'scheduled_meeting';

alter table call_participants
  add column event_response_status text,
  add column waiting_at timestamptz,
  add column admitted_at timestamptz,
  add column admitted_by uuid references users(id),
  add column role_updated_at timestamptz;

alter table call_participants drop constraint call_participants_role_check;
alter table call_participants add constraint call_participants_role_check
  check (role in ('host', 'participant', 'cohost', 'speaker', 'attendee'));

alter table call_participants drop constraint call_participants_status_check;
alter table call_participants add constraint call_participants_status_check
  check (status in (
    'invited', 'waiting', 'admitted', 'connecting', 'joined',
    'declined', 'left', 'removed', 'missed'
  ));

alter table call_participants add constraint call_participants_event_response_check
  check (event_response_status is null or event_response_status in ('needs_action', 'accepted', 'declined', 'tentative'));

create index call_participants_meeting_moderation_idx
  on call_participants(call_session_id, role, status, waiting_at)
  where role in ('host', 'cohost') or status = 'waiting';
