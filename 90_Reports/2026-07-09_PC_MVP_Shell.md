# 2026-07-09 - PC MVP Shell

## Goal

Create the first runnable HahaTalk/인비즈톡 PC MVP shell in `C:\Project\Hahattalk`.

## Files Changed

- Added shared Smart Room contracts and tests.
- Added Next.js web workspace.
- Added NestJS-style API skeleton.
- Added Electron desktop shell.
- Added harness, smoke check, schema draft, and architecture note.

## Decisions

- First version is PC web plus Electron desktop.
- Smart Room message visibility uses `message_audiences`.
- Read state uses `message_reads` with read and confirmation times.
- Attachments use metadata only in app state and future PostgreSQL; file bytes belong in S3/MinIO.
- STT, TTS, summaries, calls, and sensitive media features are represented as async/deferred flows and do not block chat.
- Remote control and recording stay disabled until explicit consent and audit logs are implemented.

## Verification

Run from the project root:

```powershell
npm install
npm run harness
npm audit --audit-level=moderate
```

Result:

- `npm run harness` passed.
- TypeScript typecheck passed for contracts, API, web, and desktop.
- Contract tests passed: 3 tests.
- Production build passed for contracts, API, web, and desktop.
- Smoke check passed.
- Dev server HTTP checks passed for `http://127.0.0.1:3000`, `http://127.0.0.1:4000/health`, `http://127.0.0.1:4000/mvp`, and `POST /messages`.
- Electron was upgraded to the audit-recommended safe major line.

## Remaining Risks

- The API uses an in-memory demo store until PostgreSQL, Redis, and S3/MinIO are wired.
- The PDF panel has the viewer integration point and object URL preview, but full PDF.js worker configuration should be added with real document storage.
- LiveKit, STT, TTS, and AI worker integrations are intentionally deferred.
- `npm audit --audit-level=moderate` still reports a Next.js nested PostCSS advisory. The automated npm fix proposes a breaking downgrade to `next@9.3.3`, so it was not applied.

## Next Step

Wire the web app to the API snapshot and message endpoints, then replace demo state with persisted PostgreSQL data.
