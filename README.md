# HahaTalk / 인비즈톡

HahaTalk is a PC-first business messenger MVP for Inviz-style work communication. It starts with a running web workspace, an Electron desktop shell, a NestJS-style API skeleton, and shared TypeScript contracts for Smart Room messaging.

## What Runs Today

- Signup/onboarding mock flow with character selection.
- API-backed signup/login session flow for the first PC work desk entry.
- Smart Room chat with `All`, `Selected`, and `Private` audience modes.
- Internal and guest invite affordances with guest-safe permission labels.
- File/photo/PDF/video metadata previews.
- Screen capture share flow for PC browsers/desktops that support `getDisplayMedia`.
- Read report panel with read time, unread users, and confirmation state.
- Pop-out window affordances for chat and document views.
- Async AI/STT/TTS placeholders that do not block chat.

## Commands

```powershell
npm install
npm run dev:web
npm run dev:api
npm run dev:desktop
npm run typecheck
npm run build
npm run smoke
npm run harness
```

The web MVP runs at `http://127.0.0.1:3000`.

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
