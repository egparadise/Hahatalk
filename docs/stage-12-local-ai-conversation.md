# Stage 12 Local AI Conversation

HahaTalk 0.19.0 adds a private, text-first `HahaTalk AI` direct conversation for the workspace owner. The assistant runs through the loopback-only Ollama API with `qwen3.5:4b`; chat persistence never waits for model inference.

## User Setup

```powershell
ollama pull qwen3.5:4b
```

Keep Ollama running, open the Windows HahaTalk application, sign in, and select `HahaTalk AI` from the room list. The room header shows `Local AI / Qwen3.5-4B`; normal text messages receive local model replies. Voice/video calls and file sharing are disabled in this first assistant-room slice.

## Runtime Path

```text
owner sends a normal direct message
 -> message/deliveries/outbox commit immediately
 -> assistant ai_job is queued with sourceMessageId only
 -> embedded API claims one assistant job with a fenced lease
 -> bounded visible conversation context is read from PostgreSQL
 -> loopback Ollama /api/chat, think=false
 -> assistant message/deliveries/outbox commit
 -> Socket.IO message:created reaches the owner
```

- The queue payload does not duplicate message text; it stores only the source message identifier.
- Ollama URLs must resolve to loopback HTTP. Remote model endpoints are rejected by this embedded worker.
- The configured model must begin with `qwen3.5`; older Qwen models are rejected.
- Internal thinking output is disabled and never stored or projected.
- One embedded worker processes replies sequentially, preserving response order for this first single-owner slice.
- A failed model call is retried once. Final failure becomes an explicit AI connection-error message rather than a fabricated answer.
- The AI user has no password and cannot authenticate as a human account.

## Local Data Reset

`tools/maintenance/reset-installed-test-data.mjs` clears installed conversation messages, deliveries, message attachments, conversation-bound AI jobs, message outbox events, push jobs, and message/media idempotency rows. It preserves accounts, memberships, room definitions, private media originals, invitations, schedules, calls, and audit history.

The tool requires a healthy packaged loopback runtime, migration `017`, and the exact confirmation token:

```powershell
npm run data:reset:installed -- --confirm=RESET_HAHATALK_TEST_DATA
```

Optional `--owner-email` and `--owner-name` values update the existing owner identity without changing its password or role. The reset writes a count-only audit event and never records deleted message bodies.

## Verification

```powershell
npm run assistant:integration
npm run harness -- -Mode pre-commit -Feature local-ai-conversation
```

The integration harness uses a fresh PostgreSQL database and deterministic loopback model server. It proves migration application, two-member direct projection, sub-inference chat latency, typing and message realtime events, Qwen model selection, thinking suppression, identifier-only queue input, idempotent replay, retry, durable success/failure, and explicit user-visible failure.

Real-machine verification additionally logs into the packaged API, sends a normal assistant-room message, receives a model-labeled `qwen3.5:4b` reply through Ollama on the RTX GPU, clears that verification exchange, and confirms zero remaining conversation rows before leaving the installed UI running.

## Primary References

- [Ollama Qwen 3.5 model library](https://ollama.com/library/qwen3.5)
- [Ollama chat API](https://docs.ollama.com/api/chat)
