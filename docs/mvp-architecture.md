# HahaTalk Architecture V2

## Runtime

- `apps/web`: Next.js + TypeScript work desk and browser client.
- `apps/desktop`: Electron shell for Windows capture, tray, multi-window, and future support-agent launch.
- `apps/mobile`: planned Expo/React Native app for Android and iOS.
- `apps/api`: NestJS modular monolith for identity, conversations, media, schedule, calls, broadcasts, AI jobs, consent, and audit.
- `packages/contracts`: shared viewer-safe domain contracts.
- PostgreSQL: relational state and metadata.
- Redis: presence, rate limits, queues, and Socket.IO scale-out.
- S3/MinIO: file, photo, video, audio, recording, avatar, and generated media bytes.
- LiveKit: voice, video, screen sharing, webinar, and broadcast media.
- Python workers: Whisper-compatible STT, Qwen 3.5+ assistant jobs, Qwen3-TTS, summaries, and avatar processing.
- Remote support control plane: HahaTalk consent/audit orchestration with a separately sandboxed Windows support agent.

## Conversation Products

| Type | Owner view | Other user view | Roster |
| --- | --- | --- | --- |
| `direct` | 1:1 | 1:1 | Two users only |
| `open_group` | Shared group | Shared group | Visible |
| `hub` | Multi-person owner console | Direct chat with owner | Owner only |
| `broadcast_channel` | Publisher studio | Channel/feed | Count or policy-based |

The previous `smart_room` label is replaced by the explicit `hub` model. A hub participant must not receive the canonical room type/name, member count, other memberships, presence, delivery records, read reports, target IDs, or shared socket events.

## Hub Delivery Path

```text
POST /messages
  -> validate authenticated membership
  -> store sender intent in message_audiences
  -> resolve recipient snapshot into message_deliveries
  -> persist message + deliveries + outbox event atomically
  -> project a viewer-safe message per recipient
  -> emit only to user:<recipient_id>
```

An owner `all` message becomes `hub_announcement`; each participant receives it inside their private spoke. A participant reply is normalized to a direct delivery between that participant and the owner, even if a manipulated client submits other target IDs.

## Current Executable Slice

- API-backed signup/login and character selection.
- Viewer-specific `GET /mvp?viewerId=...` snapshot.
- Viewer-specific `GET /spaces/:spaceId/view?viewerId=...` projection.
- API-backed `POST /messages`, `POST /invites`, and `POST /attachments`.
- Delivery-based visibility and read confirmation through `POST /messages/:messageId/confirm`.
- User-specific Socket.IO rooms instead of hub-wide message broadcast.
- File/photo/PDF/video metadata previews and PC capture path.
- Repo-local AGENTS, Skill, Agents, Hooks, schema validation, and harness loop.

## Production Boundaries Still Required

- Replace demo identity headers/query parameters with verified sessions and authorization guards.
- Persist through PostgreSQL transactions and publish through an outbox worker.
- Add Redis presence without exposing hub participants to one another.
- Add signed multipart upload, virus scanning, metadata extraction, and media derivatives.
- Add LiveKit token service, E2EE key policy, call state, and consented recording.
- Add AI worker services; chat must never await them.
- Add a support-agent security review before remote control code is enabled.

## Sensitive Feature Rules

Remote support, recording, screen sharing, external file sharing, transcript export, avatar source retention, and voice profiles require explicit current consent, a visible active indicator, immediate stop/revoke, and append-only audit events. Voice-cloned TTS is never created from incidental call recordings.
