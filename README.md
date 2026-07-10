# HahaTalk / 인비즈톡

HahaTalk is a KakaoTalk-like messenger with direct chat, traditional open groups, an owner-centered private hub, and personal broadcasting. It runs as a PC web MVP and as a self-starting Windows Electron application with an embedded NestJS API; Android and iOS clients are staged after the persisted conversation API.

## What Runs Today

- Signup/onboarding mock flow with character selection.
- API-backed signup/login session flow for the first PC work desk entry.
- Viewer-specific hub snapshot, `POST /messages`, and approval-aware `POST /invites` flow.
- API-backed attachment metadata for files, photos, PDFs, videos, and screen captures.
- API-backed confirmation action for important read-report messages.
- Hub owner chat with `All`, `Selected`, and `Private` audience modes.
- Participant-safe projection that presents the same hub as a normal 1:1 owner conversation.
- Per-recipient `message_deliveries` and user-specific Socket.IO channels that prevent hub roster/message leakage.
- Internal and guest invite affordances with guest-safe permission labels.
- File/photo/PDF/video metadata previews.
- Screen capture share flow for PC browsers/desktops that support `getDisplayMedia`.
- Read report panel with read time, unread users, and confirmation state.
- Pop-out window affordances for chat and document views.
- Async AI/STT/TTS placeholders that do not block chat.
- A Windows x64 package and Squirrel installer that start without Node.js, npm, or separate development servers.
- Single-instance protection, dynamic loopback ports, runtime health evidence, secure navigation, and clean API shutdown.

## Commands

```powershell
npm install
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
npm run harness
```

The web MVP runs at `http://127.0.0.1:3000`.

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
- `AGENTS.md`, `.agents/skills`, and `.codex`: persistent development direction, stage workflow, specialist agents, and lifecycle hooks.
