# HahaTalk PC MVP Architecture

## Runtime

- `apps/web`: Next.js and TypeScript PC work desk.
- `apps/desktop`: Electron shell for native windowing and PC capture workflows.
- `apps/api`: NestJS-style TypeScript API skeleton for chat, invites, reads, attachments, audit, and future realtime events.
- `packages/contracts`: Shared TypeScript domain contracts and demo fixtures.

## MVP Rules

- Chat send must stay fast and never wait for AI, STT, TTS, file preview, or video work.
- Signup/login creates a short-lived demo `AuthSession` before entering the work desk.
- The web work desk reads `MvpSnapshot` from the API and writes messages/invites through `POST /messages` and `POST /invites`.
- Message visibility is determined by `message_audiences`.
- Read reports are sensitive work data and should be guarded by room membership checks in the API layer.
- File originals belong in S3-compatible storage or MinIO. PostgreSQL stores metadata only.
- Screen sharing, recording, remote control, AI transcript export, and external sharing require explicit consent and audit logs before production release.

## Deferred Production Pieces

- PostgreSQL persistence and migrations.
- Redis presence and job queue.
- S3/MinIO signed upload flow.
- LiveKit integration for calls and webinars.
- Python workers for `Silero VAD`, `faster-whisper`, and `MeloTTS-Korean`.
- Full permission middleware, rate limits, and audit export.
