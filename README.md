# HahaTalk / 인비즈톡

HahaTalk is a KakaoTalk-like messenger with direct chat, traditional open groups, an owner-centered private hub, and personal broadcasting. It runs as a PC web MVP and as a self-starting Windows Electron application with an embedded NestJS API; Android and iOS clients are staged after the persisted conversation API.

## What Runs Today

- PostgreSQL-backed signup/login with Argon2id passwords and character selection.
- Opaque HttpOnly cookie sessions whose SHA-256 digests, expiry, revocation, and audit events persist across API restarts.
- PostgreSQL-backed 1:1, open-group, and private-hub timelines with keyset pagination; client-supplied viewer/sender IDs are ignored.
- One-time invitation codes whose SHA-256 digests, expiry, use count, approval snapshot, invitee decision, and audit events persist in PostgreSQL.
- Owner/admin/all-member/quorum approval policies, guest acceptance with terms/privacy/group consent, and manager revoke.
- Device-session list, single-session revoke, revoke-other-sessions, and rate-limited login/invitation endpoints.
- Attachment metadata preview remains a temporary demo boundary until Stage 5 object storage is connected.
- API-backed confirmation action for important read-report messages.
- Hub owner chat with `All`, `Selected`, and `Private` audience modes.
- Participant-safe projection that presents the same hub as a normal 1:1 owner conversation.
- Per-recipient `message_deliveries` and authenticated user-specific Socket.IO channels that prevent hub roster/message leakage.
- Atomic idempotency keys and one-recipient outbox events for retry-safe message creation and realtime projection.
- Persisted reply, edit, delete, search, read time, and explicit confirmation flows.
- Owner-private family/team/customer/service/custom contact collections with private labels, notes, normalized tags, and follow-up state.
- Exact-policy-version consent for shared family/team collections, viewer-safe rosters, revoke/re-consent, and append-only policy/audit history.
- A PC contacts desk for collection/member management and restricted guest consent without exposing owner-private relationship data.
- Internal and guest invite affordances with guest-safe permission labels.
- File/photo/PDF/video metadata previews.
- Screen capture share flow for PC browsers/desktops that support `getDisplayMedia`.
- Read report panel with read time, unread users, and confirmation state.
- Pop-out window affordances for chat and document views.
- Async AI/STT/TTS placeholders that do not block chat.
- A Windows x64 package and Squirrel installer that include a managed PostgreSQL 18.4 runtime and start without Node.js, npm, Docker, or separate development servers.
- Single-instance protection, dynamic loopback ports, runtime health evidence, secure navigation, and clean API shutdown.

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
npm run harness
```

The web MVP runs at `http://127.0.0.1:3000`. The API now fails closed when PostgreSQL is unavailable. `npm run infra:up` starts the shared PostgreSQL/Redis/object-storage development stack; the portable command starts only PostgreSQL 18.4 under `%LOCALAPPDATA%\HahaTalkDev` for Windows machines whose Docker WSL engine is unavailable.

The Windows installer is generated at `apps/desktop/out/make/squirrel.windows/x64/HahaTalkSetup.exe`. It is currently unsigned and intended for local development validation until a Windows code-signing certificate is configured.

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
- `AGENTS.md`, `.agents/skills`, and `.codex`: persistent development direction, stage workflow, specialist agents, and lifecycle hooks.
