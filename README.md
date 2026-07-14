# HahaTalk / 인비즈톡

HahaTalk is a KakaoTalk-like messenger with direct chat, traditional open groups, an owner-centered private hub, personal broadcasting, and a consent-aware AI workbench. It runs as a PC web MVP, a self-starting Windows Electron application with an embedded NestJS API, and an Expo Android/iOS companion.

## What Runs Today

- PostgreSQL-backed signup/login with Argon2id passwords and character selection.
- Opaque HttpOnly cookie sessions whose SHA-256 digests, expiry, revocation, and audit events persist across API restarts.
- PostgreSQL-backed 1:1, open-group, and private-hub timelines with keyset pagination; client-supplied viewer/sender IDs are ignored.
- One-time invitation codes whose SHA-256 digests, expiry, use count, approval snapshot, invitee decision, and audit events persist in PostgreSQL.
- Owner/admin/all-member/quorum approval policies, guest acceptance with terms/privacy/group consent, and manager revoke.
- Device-session list, single-session revoke, revoke-other-sessions, and rate-limited login/invitation endpoints.
- Resumable file/photo/PDF/video/audio upload with per-part and final SHA-256 verification, MIME/signature checks, quarantine, and restart recovery.
- Owner-private media archive, exact conversation grants, guest download policy, immediate share revoke, date/place filters, and albums.
- API-backed confirmation action for important read-report messages.
- Hub owner chat with `All`, `Selected`, and `Private` audience modes.
- Participant-safe projection that presents the same hub as a normal 1:1 owner conversation.
- Per-recipient `message_deliveries` and authenticated user-specific Socket.IO channels that prevent hub roster/message leakage.
- Atomic idempotency keys and one-recipient outbox events for retry-safe message creation and realtime projection.
- Persisted reply, edit, delete, search, read time, and explicit confirmation flows.
- Owner-private family/team/customer/service/custom contact collections with private labels, notes, normalized tags, and follow-up state.
- Exact-policy-version consent for shared family/team collections, viewer-safe rosters, revoke/re-consent, and append-only policy/audit history.
- A PC contacts desk for collection/member management and restricted guest consent without exposing owner-private relationship data.
- A timezone-safe PC calendar desk with private, selected, and exact current-room snapshot schedules, bounded recurrence, RSVP, reminders, optimistic edits, cancellation, and pop-out windows.
- LiveKit-backed ad-hoc voice/video calls with exact conversation snapshots, short-lived least-privilege tokens, incoming-call realtime state, microphone/camera controls, reconnect UI, and host/participant end paths.
- Calendar-bound scheduled meetings with an exact occurrence snapshot, waiting lobby, admission, host/cohost/speaker/attendee roles, subscribe-only attendees, and live permission revocation.
- Explicit one-at-a-time screen sharing with a visible shared-screen stage, scheduled-meeting role checks, immediate stop/revoke, and audit history.
- Active-call camera/microphone/speaker selection plus locally packaged MediaPipe background blur or a temporary user-selected image; device IDs and background images are not persisted.
- Unanimous, policy-versioned call/meeting recording consent with host/cohost start, participant revoke, visible `REC` state, LiveKit Room Composite Egress, protected MP4 metadata, signed webhooks, and fail-closed stop uncertainty.
- Validated central-media deployment manifests for trusted LiveKit/TURN, shared authenticated Redis, isolated Egress, private S3-compatible recording storage, upload-only worker credentials, and bounded retention.
- PostgreSQL-backed personal broadcast channels with separate subscriptions, scheduled/live lifecycle, hidden subscribe-only viewers, host/cohost/speaker roles, moderated anonymous Q&A, reactions, private-service handoff, and replay fail-closed behavior.
- A Windows broadcast work desk with real LiveKit media, owner-only participant controls, viewer-safe projections, live role promotion/demotion, and independent pop-out windows.
- Hidden-hub calls remain owner-to-one-spoke in Stage 6B so no other spoke identity can appear in a provider room; open groups support exact multi-user call snapshots.
- Internal and guest invite affordances with guest-safe permission labels.
- Authenticated PDF.js, image, video, audio, and text previews without public storage URLs or third-party document viewers.
- Durable screen capture archive/share flow for PC browsers/desktops that support `getDisplayMedia`.
- Read report panel with read time, unread users, and confirmation state.
- Pop-out window affordances for chat and document views.
- PostgreSQL-backed AI jobs with lease, heartbeat, fencing, idempotency, retry/cancel, attempt history, and optional opaque Redis Streams wake-ups; chat never waits for a model or worker.
- A Windows AI workbench for faster-whisper STT drafts, visibility-scoped Qwen 3.5+ summaries, Qwen3-TTS Sohee playback, consented voice profiles, and AI-labeled avatar assets.
- Editable STT review and explicit one-time approval before a normal Smart Room message is sent, plus immediate voice-consent revoke and derivative deletion queues.
- A Windows x64 package and Squirrel installer that include a managed PostgreSQL 18.4 runtime and start without Node.js, npm, Docker, or separate development servers.
- Single-instance protection, dynamic loopback ports, runtime health evidence, secure navigation, and clean API shutdown.
- Consent-bound Windows remote support with exact requester/target roles, expiring activation credentials, monotonic command fencing, pause/revoke/emergency stop, and an unsigned-agent dry-run boundary that cannot inject native input.
- Expo SDK 57 Android/iOS companion with protected routes, SecureStore sessions, AES-256-GCM offline replies, Smart Room viewer-safe chat, media viewing/sharing, calendar RSVP, broadcast viewing, and LiveKit call participation.
- Rotating mobile refresh tokens, bearer-authenticated Socket.IO, encrypted push tokens, generic no-content message/call/meeting/broadcast jobs, lease/retry delivery, and logout/device revocation cleanup.

## Commands

```powershell
npm install
npm run infra:up
# Windows fallback when Docker/WSL is unavailable:
npm run infra:postgres:portable
npm run dev:web
npm run dev:api
npm run dev:desktop
npm run desktop:runtime
npm run desktop:package
npm run desktop:make
npm run desktop:check
npm run typecheck
npm run build
npm run smoke
npm run schema:check
npm run auth:integration
npm run invitation:integration
npm run conversation:integration
npm run contacts:integration
npm run media:integration
npm run calendar:integration
npm run infra:livekit:portable
npm run calls:integration
npm run meetings:integration
npm run screen-share:integration
npm run recording:integration
npm run broadcasts:integration
npm run ai:integration
npm run remote-support:integration
npm run mobile:check
npm run mobile:integration
npm run mobile:export
npm run mobile:bundle-check
npm run media-infra:check
# Requires a healthy Docker Linux engine and performs a real Room Composite MP4 test:
npm run media-infra:smoke
npm run desktop:renderer-smoke
npm run desktop:call-renderer-smoke
npm run desktop:meeting-renderer-smoke
npm run desktop:broadcast-renderer-smoke
npm run desktop:stage6d-renderer-smoke
npm run desktop:stage6e-renderer-smoke
npm run desktop:stage7-renderer-smoke
npm run desktop:stage8-renderer-smoke
npm run desktop:stage9-renderer-smoke
npm run harness
```

The web MVP runs at `http://127.0.0.1:3000`. The API fails closed when PostgreSQL is unavailable. `npm run infra:up` starts the shared PostgreSQL/Redis/object-storage development stack; the portable commands prepare PostgreSQL 18.4 and the checksum-pinned LiveKit 1.13.3 Windows test server under `%LOCALAPPDATA%\HahaTalkDev`. The LiveKit development server is loopback-only and is not an external deployment. Real users require configured `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` backed by trusted TLS and TURN. Recording additionally requires a separately deployed LiveKit Egress service, protected S3-compatible storage, and the `LIVEKIT_EGRESS_*` settings documented in `.env.example`; the Windows client does not bundle Egress. `infra/media` renders and validates this central-service boundary without committing credentials. Production LiveKit and storage credentials belong in a centrally managed API/secret manager, never in an end-user desktop installation or renderer.

The Windows installer is generated at `apps/desktop/out/make/squirrel.windows/x64/HahaTalkSetup.exe`. It is currently unsigned and intended for local development validation until a Windows code-signing certificate is configured.

The mobile Hermes exports are generated under `apps/mobile/dist/android` and `apps/mobile/dist/ios`. APK/IPA signing, APNs/FCM delivery, and physical-device camera/microphone validation remain external release gates that require a real EAS project and store credentials; mobile remote control and screen publishing remain disabled.

## Project Operations

- Code root: `C:\Project\Hahattalk`
- Obsidian report root: `C:\Users\egpar\OneDrive - Inviz\15.Vibe Cording\Obsidian\hahtalk\HahaTalk`
- Git remote: `https://github.com/egparadise/Hahatalk.git`

Create a dated Obsidian report:

```powershell
npm run report:new -- -Feature "feature-name" -Goal "short goal"
```

Run the managed development loop after a feature slice is ready:

```powershell
npm run dev:loop -- -Feature "feature-name" -Mode pre-commit -Commit -Push -CommitMessage "Implement feature name"
```

The loop creates a timestamped Obsidian report, verifies the app with the harness, initializes Git in the code root when needed, commits, pushes, and records the branch/commit/push result.

## Architecture And Roadmap

- `docs/product-blueprint-v2.md`: product behavior and owner/participant experiences.
- `docs/schema.sql`: full V2 PostgreSQL domain schema.
- `docs/technology-decisions-2026-07-10.md`: researched model, media, mobile, and remote-support choices.
- `docs/development-roadmap-v2.md`: staged path through production release.
- `docs/security-threat-model.md`: privacy boundaries and mandatory leakage tests.
- `docs/windows-desktop-runtime.md`: packaged Windows startup, security, build, and runtime verification.
- `docs/stage-2-auth-persistence.md`: Stage 2A database, password, cookie, migration, and restart-test contract.
- `docs/stage-2b-invitations-consent.md`: Stage 2B invitation state machine, guest approval, consent evidence, API, and tests.
- `docs/stage-3-persisted-conversations.md`: Stage 3 conversation schema, privacy projection, idempotency, outbox, API, and test contract.
- `docs/stage-4-contacts-family-managed-groups.md`: Stage 4 relationship authorization, versioned consent, viewer projections, PC UX, and privacy harness.
- `docs/stage-5-media-document-desk.md`: Stage 5 resumable upload, inspection, object storage, viewer grants, PDF/media UX, and verification contract.
- `docs/stage-6a-schedule-rsvp-reminders.md`: Stage 6A timezone, recurrence, snapshot authorization, RSVP, reminders, calendar UX, and verification contract.
- `docs/stage-6b-livekit-call-core.md`: Stage 6B call state, privacy projection, least-privilege tokens, LiveKit provider boundary, PC UX, and verification contract.
- `docs/stage-6c-scheduled-meeting-lobby.md`: Stage 6C occurrence binding, lobby admission, media roles, live permission updates, PC UX, and verification contract.
- `docs/stage-6d-screen-share-device-background.md`: Stage 6D explicit screen permission, device/background privacy, PC UX, and installed-renderer verification contract.
- `docs/stage-6e-recording-consent-egress.md`: Stage 6E unanimous recording consent, Egress/storage boundary, signed webhook, fail-closed lifecycle, PC UX, and verification contract.
- `docs/stage-6f-trusted-media-infrastructure.md`: Stage 6F trusted deployment manifest, shared Redis/Egress, private storage, retention, and real-MP4 infrastructure gate.
- `docs/stage-7-personal-broadcast.md`: Stage 7 channel subscription boundary, hidden viewers, moderated Q&A, live roles, replay gate, PC UX, and installed-renderer verification contract.
- `docs/stage-8-ai-voice-workbench.md`: Stage 8 durable jobs, worker leases, STT review, scoped summaries, Korean TTS, consented voice/avatar processing, and installed-renderer verification contract.
- `docs/stage-9-consented-remote-support.md`: Stage 9 attended support consent, command fencing, isolated agent process, emergency stop, and signed-native release gate.
- `docs/stage-10-mobile-companion.md`: Stage 10 mobile auth, encrypted offline queue, generic push, Expo routes, media/calendar/broadcast/call surfaces, and native release gates.
- `AGENTS.md`, `.agents/skills`, and `.codex`: persistent development direction, stage workflow, specialist agents, and lifecycle hooks.
