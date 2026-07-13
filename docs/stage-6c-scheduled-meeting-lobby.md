# Stage 6C Scheduled Meeting Lobby And Roles

## Scope

Stage 6C connects an exact calendar occurrence to a moderated LiveKit meeting. It adds a waiting lobby and host, cohost, speaker, and attendee roles. Screen sharing, device selection, and background processing arrive in Stage 6D; recording, STT/TTS, and broadcasting remain later stages.

## Schedule Binding

- A meeting belongs to one immutable `(event_id, occurrence_starts_at)` pair and snapshots the event version, start/end window, active attendees, and each attendee's RSVP state.
- Only the event creator can schedule the occurrence. A scheduled meeting blocks edits and cancellation of its source event until the meeting becomes terminal.
- Recurring events use the canonical occurrence timestamp returned by the calendar API. A client cannot invent a recurrence instance or alter its timezone interpretation.
- Private events contain the creator only. Selected events use the exact attendee snapshot. Hidden-hub events remain owner-to-one-spoke and reject multi-spoke meetings.

## State And Roles

- Meeting state moves through `scheduled`, `starting`, `lobby_open`, `active`, and a terminal state.
- Participant state moves independently through `invited`, `waiting`, `admitted`, `connecting`, `joined`, and terminal departure states.
- `host` can open/end the meeting, moderate the lobby, and change roles. `cohost` can admit or deny waiting users. `speaker` can publish microphone and camera. `attendee` is subscribe-only.
- Guests are always attendees. Declined event invitees remain visible to the host as snapshot evidence but cannot enter.
- Role changes use optimistic meeting versions. A connected speaker demoted to attendee is updated through LiveKit `UpdateParticipant`; publishing is revoked immediately and existing tracks are unpublished.

## Provider Boundary

- The provider room is created only when the host opens the lobby. Scheduling alone does not allocate media infrastructure or issue credentials.
- Join credentials are issued only after admission, expire after 120 seconds, and contain the exact room, random identity, subscribe permission, and role-derived audio/video publishing grants.
- Attendees receive `canPublish=false`. Hosts, cohosts, and speakers receive microphone/camera source grants for video meetings and microphone-only grants for voice meetings.
- Provider room names, tokens, keys, and secrets are excluded from ordinary projections, realtime events, outbox data, audit metadata, and logs. A random per-meeting media identity appears only in the exact authorized participant projection so the client can associate LiveKit tracks with character tiles.
- Provider permission synchronization fails closed. If a connected participant cannot be updated safely, HahaTalk removes that provider participant and records a failed participant state.

## API

- `GET /meetings/capabilities`
- `GET /meetings?eventId=<uuid>&occurrenceStartsAt=<instant>`
- `POST /meetings`
- `GET /meetings/:meetingId`
- `POST /meetings/:meetingId/open`
- `POST /meetings/:meetingId/enter`
- `POST /meetings/:meetingId/participants/:userId/admit`
- `POST /meetings/:meetingId/participants/:userId/deny`
- `PATCH /meetings/:meetingId/participants/:userId/role`
- `POST /meetings/:meetingId/join`
- `POST /meetings/:meetingId/connected`
- `POST /meetings/:meetingId/leave`
- `POST /meetings/:meetingId/end`

## PC Experience

- The calendar detail panel schedules a video/voice meeting for the selected occurrence and assigns initial roles.
- Opening a lobby shows waiting users and host/cohost moderation controls without exposing unauthorized attendees.
- Admitted users join the real LiveKit room. Attendees see and hear the meeting but have no microphone/camera publishing controls.
- Live role changes update the participant list and media controls. Removing publish permission clears the local track and restores the character tile.
- Selected live meetings refresh through recipient-scoped realtime events and a bounded two-second projection poll for missed-event recovery.

## Verification

```powershell
npm run infra:postgres:portable
npm run infra:livekit:portable
npm run meetings:integration
npm run desktop:meeting-renderer-smoke -- --executable=<installed HahaTalk.exe>
```

The fresh-database suite verifies canonical occurrence binding, exact snapshots, waiting/admission, role grants, hidden-hub and guest boundaries, optimistic updates, restart persistence, provider failure, audit, and secret non-disclosure. The installed renderer suite proves a real SFU join, subscribe-only attendee behavior, live speaker demotion, track revocation, character fallback, layout, and cleanup.
