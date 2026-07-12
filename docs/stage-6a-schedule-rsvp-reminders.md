# Stage 6A Schedule, RSVP, And Reminders

## Scope

Stage 6A provides a Windows-first calendar desk before LiveKit calling work begins.

- Private, selected-attendee, and exact current-space snapshot events.
- Whole-series create, edit with optimistic version, and cancellation.
- Daily, weekly, and monthly bounded recurrence.
- IANA timezone and local wall-clock preservation with canonical UTC instants.
- Per-attendee RSVP and creator-only attendee report.
- Event reminder offsets and viewer-specific durable dismissal.
- Month grid, selected-day agenda, editor/detail panel, and calendar pop-out.

Per-occurrence exceptions, external calendar sync, email/mobile push, and provider meeting tokens remain outside this slice.

## Time And Recurrence

`timestamptz` does not retain the timezone originally supplied by a user. HahaTalk therefore stores `starts_local`, `ends_local`, and `timezone` beside `starts_at` and `ends_at`. PostgreSQL `AT TIME ZONE` derives canonical instants and round-trip validation rejects nonexistent local times.

The API accepts structured recurrence only: daily, weekly, or monthly frequency; interval 1-12; and exactly one bounded `COUNT` or local end date. A series is capped at 366 occurrences. The server generates canonical RFC 5545 RRULE text and uses `rrule` to expand local calendar positions. PostgreSQL converts all positions to instants in one bounded batch, preserving a weekly local time across DST changes.

Every list request is limited to 93 days and 500 returned occurrences. Expanded rows are projections; the database stores the series definition rather than an unlimited occurrence table.

## Authorization

- Private events are visible only to the creator.
- Selected events materialize only explicitly permitted conversation people in `event_attendees`.
- Whole-space events materialize the current permitted recipients once. Future members receive no retroactive access.
- A hub owner may schedule for the exact current spokes. A hub participant can invite only the owner and continues to see a direct presentation.
- Guests can create private events and respond to invitations, but cannot schedule other people or a whole room.
- Only the creator can edit or cancel. An attendee can update only their own RSVP row.
- Creator responses include attendees, aggregate RSVP state, reminder offsets, and safe space context. Attendee responses omit the hub identity, other attendees, other responses, creator reminder state, and hidden member identifiers.

Update and cancel require the current integer `version`. A stale write returns `409 Conflict` without changing the event.

## Data Model

Migration `006_schedule_rsvp_reminders.sql` is the executable contract.

- `events`: local/UTC times, timezone, visibility, recurrence definition/end bound, status, cancellation, and optimistic version.
- `event_attendees`: exact user snapshot, source, RSVP, response time, and revoke history.
- `event_reminders`: unique offset definitions per event.
- `event_reminder_receipts`: viewer and occurrence-specific pending/dismissed state. Dismissal rows are created lazily rather than pre-creating an infinite reminder queue.
- `audit_logs`: create, update, cancel, RSVP, and reminder-dismiss evidence.

## API

- `GET /calendar/context`
- `GET /calendar/events?from=<instant>&to=<instant>`
- `POST /calendar/events`
- `PATCH /calendar/events/:eventId`
- `POST /calendar/events/:eventId/cancel`
- `POST /calendar/events/:eventId/rsvp`
- `POST /calendar/events/:eventId/reminders/:reminderId/dismiss`

Chat, upload, and realtime message delivery do not wait for calendar recurrence or reminder work.

## Verification

`npm run calendar:integration` uses a fresh PostgreSQL database and verifies:

- owner, invited member, uninvited hub participant, guest, and future-member projections;
- selected and whole-space exact snapshots;
- participant-to-owner scheduling without hub disclosure;
- own-row RSVP and creator-only attendee reporting;
- New York 09:00 weekly recurrence across the DST boundary;
- invalid timezone, nonexistent local time, unbounded recurrence, and oversized window rejection;
- optimistic update conflict and creator-only cancellation;
- viewer-independent reminder dismissal;
- API restart persistence, migration checksum, and audit actions.

The installed renderer smoke creates, displays, edits, cancels, and opens a private event in a separate Electron calendar window. It also checks the 42-cell month grid for stable dimensions and captures the installed calendar desk for visual review.
