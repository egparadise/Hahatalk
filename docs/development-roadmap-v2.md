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

1. Event CRUD, recurrence, attendee RSVP, reminders.
2. LiveKit token service and ad-hoc voice/video calls.
3. Scheduled meeting lobby and participant roles.
4. Screen sharing, device controls, background blur/image.
5. Recording consent and egress lifecycle.

Exit: web, Windows desktop, Android, and iOS capability matrix is tested; unsupported controls are hidden rather than simulated.

## Stage 7 - Personal Broadcast

1. Channel profile and subscription.
2. Scheduled/live/replay sessions.
3. Host, cohost, speaker, viewer roles.
4. Moderated chat, Q&A, reactions, and private-service handoff.
5. Recording, replay assets, and analytics.

Exit: viewers cannot publish or see private service chats; host can moderate and end immediately.

## Stage 8 - AI Voice, Summary, And Avatar

1. Redis-backed AI job state and Python worker protocol.
2. Silero VAD + faster-whisper STT draft/edit/send.
3. Qwen 3.5+ summaries, decisions, and task extraction.
4. Qwen3-TTS standard Korean voice with cache.
5. Consented voice profile, watermark, revoke, and deletion.
6. Photo-to-caricature assets, expression packs, then optional animated avatar.

Exit: AI failure never blocks chat; drafts are labeled; voice-profile use fails closed without current consent.

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
 -> user approval for the stage
```
