# HahaTalk AI Worker

The Stage 8 worker is a separate Python process. It is not bundled into the Electron installer and never reads the application database directly.

## Protocol

1. An authenticated client creates a durable `ai_jobs` row.
2. Redis Streams may send an opaque wake-up containing only `jobId`, `jobType`, and `schemaVersion`.
3. The worker claims work through the internal API and receives a lease plus fencing token.
4. Sensitive text or media is fetched only after the lease is active.
5. Heartbeats extend the lease. Complete/fail calls with an old fencing token are rejected.
6. The API validates output and stores generated media as a private `ai_generated` asset.

## Environments

- Core wake-up support: `pip install -r workers/ai/requirements-core.txt`
- Local models: `pip install -r workers/ai/requirements-models.txt`
- Required: `AI_WORKER_TOKEN`, matching the API environment.
- Optional: `AI_REDIS_URL`, `WHISPER_MODEL`, `WHISPER_DEVICE`, `QWEN_OPENAI_BASE_URL`, `QWEN_MODEL`, `QWEN_TTS_MODEL`, `QWEN_TTS_DEVICE`.

`HAHATALK_AI_TEST_DRIVER=deterministic` is accepted only by test harnesses. It never represents a production model result.
