# HahaTalk Repository Guidance

## Canonical Locations

- Program code and Git root: `C:\Project\Hahattalk`
- Planning, decisions, learning notes, and reports: `C:\Users\egpar\OneDrive - Inviz\15.Vibe Cording\Obsidian\hahtalk\HahaTalk`
- Git remote: `https://github.com/egparadise/Hahatalk.git`

Do not move application code into the Obsidian vault. Do not treat the vault as the program Git root.

## Product Model

HahaTalk is a KakaoTalk-like messenger with four distinct conversation products:

1. `direct`: ordinary private 1:1 chat.
2. `open_group`: a traditional group room where members and shared messages are visible.
3. `hub`: the owner sees one multi-person console; every non-owner sees only a direct conversation with the owner and must not learn that other participants exist.
4. `broadcast_channel`: one-to-many personal broadcasting with subscriptions and moderated chat.

Never represent `hub` as an ordinary group room in participant-facing API responses, realtime events, logs, counts, presence, read reports, or UI. Persist sender intent in `message_audiences`, resolve immutable recipients in `message_deliveries`, and project one viewer-safe response per recipient.

## Required Stage Loop

Use `$hahatalk-feature-stage` for feature, architecture, schema, AI/media, security, test, build, commit, or push work.

1. Read the latest Obsidian report and relevant architecture documents.
2. Check Git status and preserve unrelated user changes.
3. Search current primary sources before each stage; record source, date, decision, and rejected alternatives in Obsidian.
4. Create `90_Reports/YYYY-MM-DD_HH-mm_<feature>.md` before editing.
5. Confirm schema, permission, consent, audit, loading, error, retry, and privacy behavior.
6. Implement one vertical slice.
7. Run typecheck, tests, build, smoke, and the closest executable app flow.
8. Fix and repeat until clean.
9. Update the report, prompt log, decision log, and a learning page when a new concept is introduced.
10. Commit and push only after the harness passes. Record branch, commit, and push result.

Git is initialized once per repository. For later stages, verify with `git rev-parse --is-inside-work-tree`; do not create nested repositories.

## Engineering Invariants

- Chat send never waits for AI, STT, TTS, avatar, file preview, or media processing.
- Persist before broadcasting; use an outbox for durable realtime publication.
- Use idempotency keys for messages, uploads, AI jobs, invitations, and remote support requests.
- Store binary objects in S3/MinIO and metadata in PostgreSQL.
- Use cursor pagination and virtualized lists for large timelines.
- Keep heavy AI on private workers, not mobile clients.
- Use Qwen 3.5 or newer behind a model configuration interface; never hard-code one deployment as the only provider.
- Use Whisper-compatible STT asynchronously. Generated transcripts are drafts until reviewed.
- Treat voice profiles as biometric data. Never build a voice from incidental recordings without explicit, revocable consent.
- Remote view, remote control, recording, transcript export, and external sharing require current session-scoped consent, visible active state, immediate stop/revoke, and append-only audit events.
- iOS and Android may have platform-limited remote support behavior; do not claim unsupported full device control.

## Verification Commands

```powershell
npm run typecheck
npm test
npm run build
npm run smoke
npm run schema:check
npm run harness
```

The feature is incomplete while any relevant check fails or while the running user flow has not been inspected.

## Documentation Integrity

Record the user's prompts verbatim when practical and record assistant decisions as concise rationale, alternatives, and evidence. Do not claim to store hidden chain-of-thought. Store durable conclusions that another developer can verify.
