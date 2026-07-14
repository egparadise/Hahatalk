# Stage 8 AI Voice Workbench

Stage 8 adds a durable, provider-neutral AI workbench without making chat depend on an AI model, Redis, or a Python worker.

## Runtime boundaries

- PostgreSQL `ai_jobs` is the source of truth.
- Redis Streams is an optional wake-up transport and carries only `jobId`, `jobType`, and `schemaVersion`.
- The Python worker claims a lease through an authenticated internal API. It cannot read the application database.
- Every claim increments a fencing token. Heartbeat, upload, complete, and fail calls from an expired worker are rejected.
- Model weights, raw voice embeddings, worker secrets, and generated binaries are excluded from Git and Electron packages.

## Models

- STT: faster-whisper `1.2.1`, using its Silero VAD path. The default model policy is `large-v3-turbo`; Windows can choose a smaller model through worker configuration.
- Summary: Qwen `3.5` or newer. The default local policy is `Qwen3.5-4B`; an OpenAI-compatible Qwen endpoint may provide a larger deployment.
- Standard Korean TTS: `Qwen3-TTS-12Hz-0.6B-CustomVoice`, speaker `Sohee`.
- Personal voice: separated from standard TTS. Enrollment requires current, purpose-bound consent and a watermark-capable encrypted vault adapter.
- Avatar: a provider-neutral caricature adapter. Source retention consent and AI labeling are mandatory.

## User workflows

### STT review

1. Record or select a private audio file.
2. Create an STT job; the normal chat path returns immediately.
3. The worker downloads the input only while its lease is active.
4. The output is stored as `ai_draft` and is visible only to the requester.
5. The requester edits, rejects, or approves the draft.
6. Approval sends exactly one normal Smart Room message to the currently selected audience with AI review metadata.

### Conversation summary

The API snapshots at most 200 message IDs that the requester can actually receive. A worker receives those messages only after claiming the job. A hidden selected/private message is never added to another member's snapshot.

### TTS and generated media

Generated WAV/image output is uploaded through the worker lease endpoint, scanned by the existing media inspector, and stored as a private `ai_generated` media asset. TTS cache keys include requester, text, settings, model, and optional voice profile.

### Voice consent

Only a user-owned reference recording may be enrolled. Consent has a policy version, disclosure version, purpose, digest, and expiry. Revocation cancels queued/running syntheses, blocks new requests, and queues deletion of encrypted derivatives.

## Failure behavior

- Redis down: the PostgreSQL polling path remains available.
- Worker down: jobs remain queued; chat and media continue normally.
- Worker lease expires: another worker can claim the job with a higher fencing token.
- Invalid model output: the lease remains active so the worker can submit a corrected bounded result or fail it.
- Consent revoked while TTS runs: the job is cancelled and late output is rejected.

## Configuration

- API: `AI_WORKER_TOKEN`, optional `AI_REDIS_URL`.
- Worker: `HAHATALK_API_URL`, `AI_WORKER_TOKEN`, `AI_WORKER_ID`, optional `AI_REDIS_URL`.
- STT: `WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE`.
- Summary: `QWEN_OPENAI_BASE_URL`, `QWEN_MODEL`, optional `QWEN_API_KEY`.
- TTS: `QWEN_TTS_MODEL`, `QWEN_TTS_DEVICE`.

Production secrets must be supplied by the deployment environment and must not be committed.

## Verification

`npm run ai:integration` creates a fresh PostgreSQL database and proves authorization denial, idempotency conflict, lease recovery, stale fencing rejection, STT review/send, visibility-scoped summary input, Qwen version floor, TTS cache, consent revoke/delete, avatar media ingestion, retry/cancel, restart persistence, and chat independence.

`npm run desktop:stage8-renderer-smoke` launches the installed `0.15.0` Electron app with an isolated user-data directory and embedded PostgreSQL. It proves STT draft editing and explicit send, summary and TTS completion projection, generated audio playback, panel geometry, screenshot capture, and removal of the Electron, API, web, PostgreSQL, and temporary-data process tree.

The deterministic harness validates orchestration and security boundaries, not model quality. Real faster-whisper, Qwen, Qwen3-TTS, voice-vault, and avatar inference requires separately provisioned model weights and approved GPU hardware; that benchmark is recorded as a deployment gate rather than a simulated pass.
