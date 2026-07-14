# HahaTalk Architecture V2

## Runtime

- `apps/web`: Next.js + TypeScript work desk and browser client.
- `apps/desktop`: Electron shell for Windows capture, tray, multi-window, and future support-agent launch.
- `apps/mobile`: planned Expo/React Native app for Android and iOS.
- `apps/api`: NestJS modular monolith for identity, conversations, media, schedule, calls, broadcasts, AI jobs, consent, and audit.
- `packages/contracts`: shared viewer-safe domain contracts.
- PostgreSQL: relational state and metadata.
- Redis: presence, rate limits, queues, and Socket.IO scale-out.
- Object storage provider: the packaged Windows baseline uses a private per-user filesystem root; managed deployments will use the same contract with S3-compatible storage. The pinned MinIO image is local-development-only.
- LiveKit: voice, video, screen sharing, webinar, and broadcast media.
- Central media deployment: trusted LiveKit signaling/TURN, one authenticated Redis boundary shared with separately isolated Egress workers, and private S3-compatible recording storage. Generated credentials stay outside Git and desktop packages.
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

- PostgreSQL-backed signup/login and character selection with Argon2id password hashes.
- Opaque HttpOnly/SameSite cookie sessions; only SHA-256 token digests are stored in `web_sessions`.
- Authenticated `GET /auth/me`, `POST /auth/logout`, `GET /mvp`, and `GET /spaces/:spaceId/view` projection.
- Exact-Origin and custom-header checks on state-changing browser requests.
- PostgreSQL-backed `POST /messages`, reply/edit/delete/search, keyset pagination, and read/confirmation state.
- Atomic idempotency records and one-recipient transactional outbox events, published to authenticated user-specific Socket.IO rooms.
- Authenticated `/media` resumable upload, integrity/MIME inspection, owner archive, exact viewer grants, revoke, albums, metadata, and ranged content delivery.
- PostgreSQL-backed `/invitations` create/list/preview/accept/decline/decision/revoke state machine.
- PostgreSQL-backed `/auth/sessions` list and session-revoke controls.
- PostgreSQL-backed owner-private contact collections, relationship notes/tags/follow-up, immutable sharing policies, and append-only exact-version consent.
- Viewer-specific `/contacts` owner, pending-request, and consented-shared projections plus the PC contacts management desk.
- Delivery-based visibility and read confirmation through `POST /messages/:messageId/confirm`.
- Authenticated user-specific Socket.IO rooms instead of hub-wide message broadcast.
- Authenticated PDF.js/image/video/audio/text previews, durable PC capture, and independent document/media windows.
- Calendar-bound scheduled meetings with exact occurrence snapshots, moderated waiting rooms, role-scoped LiveKit tokens, and live participant permission updates.
- Explicit one-at-a-time screen-share grants, source-separated screen/camera stages, in-session device switching, and on-device MediaPipe background blur/image processing.
- Stage 6F manifest validation for trusted signaling/TURN, shared Redis, Egress health/capacity settings, upload-only recording writes, private-object checks, and bounded retention.
- PostgreSQL-backed broadcast channels and subscriptions, hidden subscribe-only LiveKit viewers, live stage-role updates, moderated Q&A/reactions, private-chat handoff, and a replay state that fails closed without trusted Egress.
- PostgreSQL-backed AI jobs with authenticated worker leases, fencing, visibility-scoped inputs, editable STT drafts, Qwen 3.5+ model policy, standard Korean TTS, and purpose-bound voice/avatar consent.
- An optional Redis Streams wake-up adapter that carries only opaque job identifiers; the Python worker receives authorized inputs through the internal API and never reads the application database.
- Repo-local AGENTS, Skill, Agents, Hooks, schema validation, and harness loop.

## Production Boundaries Still Required

- Replace demo account claiming with invitation/email verification, passkeys or enterprise SSO, device-session management, and rate limiting.
- Move the single-process outbox publisher to a leased multi-replica worker before horizontal API scaling.
- Add Redis presence without exposing hub participants to one another.
- Add the managed S3 adapter, production ClamAV service, retention policy, OCR/Office conversion, and video/audio derivative workers.
- Deploy the Stage 6F manifest on real central infrastructure with trusted DNS/certificates, TURN/TLS, firewall rules, secret-manager injection, monitoring, backup/restore, and rollback. Stages 6B-6F provide the media control plane and a strict real-MP4 smoke, but local loopback Compose is verification infrastructure rather than production. E2EE key distribution and a production-environment smoke remain deployment work.
- Keep broadcast replay unavailable until the same trusted Egress and protected object-storage gate produces and verifies a real asset; renderer-local recording is not a replay substitute.
- Deploy and benchmark the model worker profiles on approved GPU hardware; the control plane and deterministic harness are complete, but model weights are not bundled in the Windows client.
- Add a support-agent security review before remote control code is enabled.

## Sensitive Feature Rules

Remote support, recording, screen sharing, external file sharing, transcript export, avatar source retention, and voice profiles require explicit current consent, a visible active indicator, immediate stop/revoke, and append-only audit events. Voice-cloned TTS is never created from incidental call recordings.
