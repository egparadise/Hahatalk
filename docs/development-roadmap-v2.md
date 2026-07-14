# HahaTalk Development Roadmap V2

Each numbered stage is a separate branch, Obsidian report, research gate, implementation loop, build, running inspection, commit, and push. Git initialization happens once; later stages verify the existing repository instead of nesting another `.git` directory.

## Stage 0 - Product And Privacy Foundation

Deliverables:

- Four conversation products and owner/participant projections
- V2 PostgreSQL schema
- repo AGENTS, Skill, Hooks, custom Agents, schema check
- viewer-safe hub contracts and user-specific realtime delivery

Exit: participant tests prove no roster, target, delivery, or shared-room leak; harness passes.

## Stage 1 - Windows Desktop Runtime

1. Next.js static desktop export and bundled NestJS demo API.
2. Electron-managed loopback servers and dynamic port handoff.
3. Single-instance, lifecycle cleanup, navigation limits, and runtime logs.
4. User-selected Windows screen capture source.
5. Electron Forge x64 package and Squirrel installer.
6. Packaged and installed executable smoke tests.

Exit: HahaTalk starts from an installed Windows executable without Node.js or development servers, API/owner/participant checks pass, duplicate startup is rejected, and clean shutdown removes the local runtime.

## Stage 2 - Durable Identity And Consent

### Stage 2A - Persisted Authentication Foundation

1. PostgreSQL 18 migration runner with checksum and advisory lock. Complete.
2. Docker Compose stack plus a verified Windows portable-PostgreSQL fallback. Complete.
3. Argon2id password claim/signup/login and generic login failure. Complete.
4. Opaque HttpOnly cookie, hashed server session, absolute/idle expiry, `/auth/me`, and logout revocation. Complete.
5. Exact Origin/custom-header policy and authenticated HTTP/Socket.IO identity projection. Complete.
6. Restart, logout, raw-token-storage, and viewer/sender spoof differential harness. Complete.

### Stage 2B - Invitations, Devices, And Consent

1. SHA-256-digested one-time invitation code, expiry, revoke, decline, and use-count enforcement. Complete.
2. Owner/admin/all-member/quorum approval requirement snapshot and immutable per-approver decision. Complete.
3. Unclaimed guest activation, existing-account acceptance, pending membership, and guest-safe hub projection. Complete.
4. Terms/privacy/group-join policy-versioned consent and invitation audit timeline. Complete.
5. Device list, single-session revoke, revoke-other-sessions, and local Nest throttling. Complete.
6. External email delivery, Redis-distributed throttle storage, passkeys, and enterprise SSO adapters. Deferred to deployment/identity integration.

Exit: fresh-DB and installed-Windows tests prove one success under concurrent acceptance, approval/rejection/quorum behavior, guest privacy, consent/audit evidence, expiry/revoke/reuse denial, device revoke, throttling, and real UI guest login. Complete.

## Stage 3 - Conversation Core

1. Direct chat persistence and cursor history.
2. Open group membership and shared timeline.
3. Hub owner console, spokes, selected fanout, and announcement receipt.
4. Read/confirm report authorization.
5. Edit, delete, reply, search, typing, and presence without hub leakage.
6. Offline outbox, retries, idempotency, and multi-device reconciliation.

Exit: automated multi-user tests cover success, unauthorized access, manipulated targets, reconnect, and duplicate submission. Complete.

## Stage 4 - Contacts, Family, And Managed Groups

1. Owner-only contact collections.
2. Shared family/team collections.
3. Relationship notes, tags, and follow-up state.
4. Group policy changes and member consent history.

Exit: fresh-DB and installed-Windows tests prove private collection non-disclosure, owner-private relationship data, exact-version consent, viewer-safe rosters, guest restriction, audit history, restart persistence, and archive removal. Complete.

## Stage 5 - Media And Document Desk

1. Resumable object-store upload, part/final SHA-256, restart recovery, abort, and idempotent completion. Complete.
2. MIME/extension/magic-byte validation, bounded scanning, quarantine, and production ClamAV boundary. Complete for standalone baseline; production adapter deferred.
3. EXIF date/time/timezone/GPS extraction and GPS-stripped shared image derivatives. Complete.
4. Private archive versus exact shared/selected grants with immediate revoke. Complete.
5. Indexed date/place owner timeline and manual albums. Complete.
6. Authenticated PDF.js, image, video, audio, text, and local Office fallback adapters. Complete.
7. Durable desktop capture and selected-document pop-out panels. Complete.

Exit: fresh-DB and installed-Windows tests prove chat independence, resumable integrity, quarantine, hub-safe recipient grants, guest policy, immediate revoke with retained owner original, ranged delivery, indexed filters, albums, PDF canvas rendering, private app storage, and independent document windows. Complete.

## Stage 6 - Schedule, Voice, And Video

1. Event CRUD, bounded recurrence, exact-attendee snapshots, RSVP, reminders, and Windows calendar desk. Complete.
2. LiveKit token service and ad-hoc voice/video calls. Complete for Windows in Stage 6B.
3. Scheduled meeting lobby and participant roles. Complete for Windows in Stage 6C.
4. Screen sharing, device controls, background blur/image. Complete for Windows in Stage 6D.
5. Recording consent and Egress lifecycle. Complete for the Windows/web control plane in Stage 6E; real self-hosted Egress and protected-object deployment smoke remains an infrastructure gate.
6. Trusted central media deployment manifests, shared authenticated Redis, isolated Egress, private upload-only recording storage, retention, and a strict real-MP4 smoke. Configuration and fail-closed validation are complete in Stage 6F; the real-MP4 run remains pending until the local Docker Linux engine is healthy or a production-equivalent worker is supplied.

Exit: web, Windows desktop, Android, and iOS capability matrix is tested; unsupported controls are hidden rather than simulated.

Stage 6B exit evidence: fresh PostgreSQL privacy/state tests use the pinned official LiveKit Windows server, and the installed Electron renderer proves incoming-call UI, a real SFU join, camera frames, microphone controls, leave/end, and provider-room cleanup. Production external use still requires a trusted `wss` endpoint and TURN/TLS deployment.

Stage 6C exit evidence: fresh PostgreSQL plus the real provider proves canonical occurrence binding, exact attendee snapshots, lobby admission, role grants, hidden-hub/guest privacy, restart behavior, and provider failure. The installed Electron renderer proves a real scheduled-meeting SFU join, subscribe-only attendee demotion, immediate track revocation, character fallback, stable layout, and provider cleanup.

Stage 6D exit evidence: immutable migration and fresh-DB tests prove explicit screen-share grants, one active sharer, role boundaries, rollback, audit, and terminal cleanup. Installed Electron renderers prove local device selection, packaged MediaPipe background blur, real screen-track publication/stop, concurrent denial, and immediate role-demotion revocation without persisting device IDs or background images.

Stage 6E exit evidence: fresh-DB call/meeting tests prove exact joined-participant snapshots, exact-policy unanimous consent, denial/re-request, cohost control, immediate participant revoke, late-join blocking, signed webhook enforcement, provider-secret exclusion, restart reconciliation, and fail-closed room shutdown. The Windows/web UI exposes a continuous recording state and per-person consent controls. A production Egress worker and protected S3-compatible bucket are required before real MP4 output is approved.

Stage 6F exit evidence: the configuration harness renders smoke and synthetic production manifests, proves trusted `wss`/TURN requirements, exact shared Redis credentials, pinned worker images, loopback-only smoke exposure, secret redaction, an upload-only recording prefix, and lifecycle retention. `npm run media-infra:smoke` is a mandatory non-skippable deployment gate that must create, inspect, deny anonymous/Egress reads of, and remove a real MP4. On 2026-07-14 that runtime gate remained blocked because Docker Desktop could not start its Linux engine after a Windows/WSL upgrade; this is recorded as an infrastructure failure, never a passing test.

## Stage 7 - Personal Broadcast

1. Channel profile and subscription. Complete for Windows/web.
2. Scheduled/live/replay state. Scheduled/live/ended lifecycle is complete; replay fails closed until the Stage 6F trusted-Egress gate is available.
3. Host, cohost, speaker, viewer roles. Complete with live provider grants and hidden subscribe-only viewers.
4. Moderated chat, Q&A, reactions, and private-service handoff. Complete.
5. Recording, replay assets, and advanced analytics. Durable intent/status boundary is complete; real assets and advanced analytics remain deployment/product follow-up work.

Exit: viewers cannot publish or see other viewers/private service chats; host can moderate, promote/demote, remove/block, and end immediately. Complete for the Windows/web control plane and installed Electron renderer.

Stage 7 exit evidence: fresh PostgreSQL plus the pinned official LiveKit server proves channel/subscription separation, unlisted access, idempotency, hidden least-privilege tokens, moderated anonymous questions, reactions, handoff, block, restart, audit/outbox, and replay fail-closed behavior. The installed `0.14.0` Electron renderer proves hidden viewing, real-time Q&A, live permission promotion/demotion with camera track publication/revoke, layout integrity, provider cleanup, and embedded-PostgreSQL shutdown.

## Stage 8 - AI Voice, Summary, And Avatar

1. PostgreSQL source-of-truth AI jobs, optional opaque Redis wake-ups, and authenticated Python worker protocol. Complete.
2. Silero VAD + faster-whisper STT draft/edit/send. Complete in the control plane and worker adapter.
3. Qwen 3.5+ summaries, decisions, and task extraction. Complete in the control plane and OpenAI-compatible adapter.
4. Qwen3-TTS standard Korean voice with cache. Complete with the Sohee adapter and generated-media path.
5. Consented voice profile, watermark, revoke, and deletion. Complete with a fail-closed encrypted-vault adapter boundary.
6. Photo-to-caricature request/assets and source-retention consent. Complete as a provider-neutral job boundary; expression packs and animated avatars remain a later product slice.

Exit: AI failure never blocks chat; drafts are labeled; voice-profile use fails closed without current consent.

Stage 8 exit evidence: a fresh PostgreSQL harness proves chat independence, authorization denial, idempotency conflicts, lease recovery and stale-worker fencing, STT review/send, visibility-scoped summary snapshots, Qwen version enforcement, private generated media, consent revoke/delete, retry/cancel, restart persistence, and audit. Installed Electron `0.15.0` proves STT editing and approval, summary and TTS result projection, responsive layout, screenshot capture, and complete Electron/API/web/embedded-PostgreSQL cleanup. Real model-quality and GPU-latency benchmarks remain an explicit deployment gate because model weights are not bundled or present in the test environment.

## Stage 9 - Remote Support

1. Threat model and engine proof of concept.
2. Signed Windows support agent and device enrollment.
3. Separate view/control/clipboard/file grants.
4. Short-lived session credentials and relay policy.
5. Pause, emergency stop, expiry, and reconnect behavior.
6. Full audit timeline and support summary.

Exit: control cannot start or resume without a current grant; target user can end immediately; penetration review passes.

## Stage 10 - Mobile Production Clients

1. Expo/React Native shell and shared contracts.
2. Notifications, direct/open-group/hub projections, media capture, schedule, and calls.
3. iOS broadcast extension and Android foreground screen-share service where permitted.
4. Offline queue, background limits, deep links, and secure storage.

Exit: Android/iOS tests pass on real devices and capability limitations are explicit.

## Stage 11 - Hardening And Release

1. Rate limits, abuse controls, moderation, audit export.
2. RLS and authorization differential tests.
3. Backup, restore, retention, deletion, and legal policy review.
4. Load, soak, reconnect, media, and call quality tests.
5. Windows signing, Android/iOS store builds, staged rollout, telemetry, and rollback.

Exit: release candidate passes automated, manual, security, privacy, performance, backup/restore, and user acceptance gates.

Current evidence (2026-07-14): the local 0.18.0 release-candidate control plane, durable throttling, forced-RLS operations tables, redacted audit export, legal-hold lifecycle, release/rollback records, real isolated backup restore, bounded load/reconnect, manifest, SBOM, and Windows build loop are implemented. GA remains blocked by the explicitly recorded signing, physical-device, production-infrastructure, legal-policy, and real-Egress external gates.

## Standard Stage Loop

```text
Primary-source research
 -> Obsidian report + prompt log
 -> schema/contract/permission design
 -> implementation
 -> narrow test
 -> fix and repeat
 -> full harness + build
 -> run and inspect
 -> Obsidian report + learning page
 -> focused commit
 -> push
 -> continue to the next planned stage unless an external gate or product decision blocks progress
```
