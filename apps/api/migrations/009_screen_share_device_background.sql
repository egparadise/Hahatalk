alter table call_participants
  add column screen_share_status text not null default 'off',
  add column screen_share_requested_at timestamptz,
  add column screen_share_started_at timestamptz,
  add column screen_share_ended_at timestamptz;

alter table call_participants add constraint call_participants_screen_share_status_check
  check (screen_share_status in ('off', 'starting', 'active'));

alter table call_participants add constraint call_participants_screen_share_lifecycle_check
  check (
    screen_share_status = 'off'
    or screen_share_requested_at is not null
  );

create unique index call_participants_one_screen_share_idx
  on call_participants(call_session_id)
  where screen_share_status in ('starting', 'active');

create index call_participants_screen_share_status_idx
  on call_participants(call_session_id, screen_share_status)
  where screen_share_status in ('starting', 'active');
