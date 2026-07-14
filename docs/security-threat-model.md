# HahaTalk Security And Privacy Threat Model

## Highest-Value Assets

- Identity sessions, organization roles, and invitation approvals
- Hub membership and the fact that a hub exists
- Message body, recipient snapshot, presence, read/confirm state, and thread keys
- Private media originals, GPS metadata, recordings, transcripts, and avatar source photos
- Voice embeddings and cloned speech output
- LiveKit keys/tokens and remote-support control credentials
- Audit logs and deletion/retention evidence

## Trust Boundaries

- Web/mobile renderer to API
- Electron renderer to preload/main process
- API to PostgreSQL/Redis/object storage
- API to LiveKit and AI workers
- HahaTalk control plane to remote-support agent
- Internal user to guest/subscriber
- Hub owner console to participant projection

## Principal Threats And Controls

| Threat | Required control |
| --- | --- |
| Hub participant enumerates others | Viewer projections, no shared roster/presence channel, delivery-based reads, differential leakage tests |
| Client chooses another identity | HttpOnly opaque session, server-side token digest lookup, authenticated principal injected by a global guard |
| Database reader reuses a session | Store only a SHA-256 digest of a 256-bit random cookie token; revoke and expire server-side |
| XSS reads a login token | Never expose the session in JSON or web storage; use an HttpOnly/SameSite cookie |
| Cross-site request uses ambient cookie | Exact Origin allowlist, required custom header, strict CORS credentials, and SameSite=Strict |
| Password database is stolen | Argon2id with OWASP baseline memory/time parameters and per-hash salt |
| Manipulated client targets another participant | Resolve deliveries server-side; non-owner hub messages normalize to owner only |
| Shared socket leaks full message | User-specific authenticated channels and per-viewer projection |
| LiveKit token joins another room or publishes screen/data | API-generated random room/identity, two-minute JWT, exact `roomJoin`, subscribe, and microphone/camera source grants only |
| Hidden-hub call reveals another spoke | Stage 6B permits exactly one owner-spoke media room; multi-spoke calls require separate edge rooms and a future bridge |
| Unadmitted meeting user obtains media access | Issue credentials only after server-side admission and keep participant state separate from token issuance/connection |
| Attendee publishes by manipulating the UI | Sign subscribe-only attendee tokens and enforce live provider permissions; UI controls are only a projection of server grants |
| Demoted speaker keeps existing media tracks | Call LiveKit participant permission update, verify the role projection, and remove the participant on synchronization failure |
| Ended self-hosted token reconnects | Stop token issuance at terminal app state, increment participant token version, delete provider room, and keep join TTL short |
| Invitation database reveals usable code | Return raw code once; store only a 32-byte SHA-256 digest; never log it |
| Invitation is replayed or accepted concurrently | `SELECT FOR UPDATE`, use count 1, token digest scrubbing, terminal status checks |
| Client fakes approval or approval count | Snapshot eligible approvers server-side and derive progress from immutable decisions |
| Hidden hub approver learns roster/count | Minimal approver projection omits policy, aggregate count, approver list, and group size |
| Uninvited user uses open signup | Production default denies arbitrary signup; only one-time bootstrap flags or invitation activation |
| Brute-force invitation/login/message attempts | Route-specific Nest throttling with PostgreSQL-backed fixed windows that survive restart; actor/source/target trackers are one-way digests |
| Duplicate message/upload/job | Idempotency key and unique constraint |
| DB commit succeeds but realtime fails | Transactional outbox and retry worker |
| Private photo becomes shared original | Separate owned asset from share grant; safe derivative and revoke |
| GPS unintentionally disclosed | Default GPS-stripped derivative and explicit keep-location choice |
| Recording starts without consent | Exact joined-participant snapshot, exact-policy unanimous append-only consent, provider start only after snapshot recheck, and continuous visible recording state |
| Forged or replayed Egress state changes app state | Dedicated webhook content type, untouched raw body, LiveKit JWT/SHA-256 signature verification, provider-ID binding, and idempotent state application |
| Recording stop is uncertain | Attempt provider stop, delete the media room on uncertainty, invalidate participant state/tokens, mark session failed, and append fail-closed audit evidence |
| Client or audit leaks recording storage/provider identifiers | Keep Egress ID, provider room, object key, and S3 credentials server-only; emit only viewer-safe lifecycle projections and session-ID realtime hints |
| End-user desktop exposes production provider credentials | Treat the embedded API as a local MVP runtime only; keep production LiveKit/Egress/S3 credentials in a centrally managed backend and secret manager, never in the shipped renderer or desktop environment |
| Public media deployment silently falls back to insecure signaling | Reject production manifests unless signaling, Egress worker access, object storage, and webhooks use trusted TLS; require a separate TURN/TLS hostname and explicit RTC firewall ports |
| Egress credentials expose or erase recordings | Scope the worker principal to bucket location, multipart operations, and `PutObject` under `recordings/*`; deny object listing, `GetObject`, `DeleteObject`, anonymous access, and wildcard actions |
| Generated media secrets enter Git, logs, or packages | Render only into ignored operator-controlled paths, print names rather than values, redact summaries, and scan packaged resources and Git status before release |
| Recording objects persist indefinitely | Apply an organization-approved lifecycle rule, verify its exact duration in the deployment smoke, and use a separate API principal for future playback/deletion |
| Voice impersonation | Purpose-specific subject consent, encrypted embedding, watermark, audit, revoke/delete |
| Remote control uses stale approval | Session-scoped short expiry, separate control grant, target emergency stop |
| Electron renderer reaches native control | Context isolation, narrow preload API, signed separate support agent |
| AI output treated as fact | `ai_draft` state, review workflow, source links, retry/failure state |
| Audit export becomes a bulk data leak | Owner/admin authorization, bounded date/count/size, pseudonymous actor/target references, recursive metadata redaction, short private-object expiry, digest check, and download audit |
| Retention job destroys held or wrong-tenant data | Forced RLS on operations tables, canonical organization membership, dry-run preview, idempotency, scoped legal hold, second-administrator approval, deployment kill switch, and count-only results |
| Metrics create a private-ID index | Controller/handler/method/status-class labels only; no URL IDs, user, room, message, filename, object key, provider identity, token, or transcript labels |
| Unsigned or untested artifact is released | SHA-256 manifest/SBOM, mandatory evidence gates, explicit `pending_external`, rollout locked at zero, conditional provenance, and audited rollback |

## Mandatory Leakage Tests

- Compare owner and participant JSON field sets for the same hub message.
- Confirm participant responses contain no other user ID, count, target, delivery, presence, or thread key.
- Confirm cache keys include viewer identity and authorization scope.
- Confirm logs and analytics omit recipient lists for participant requests.
- Confirm read-report endpoints return aggregate data only to an authorized owner/admin.
- Confirm Socket.IO emissions target user channels and never a shared hub channel.
- Confirm `viewerId`, `senderId`, `uploaderId`, `invitedBy`, and read-confirm user IDs from a client cannot replace the authenticated principal.
- Confirm expired/revoked/declined/accepted invitation codes fail and concurrent acceptance has exactly one success.
- Confirm consent/audit JSON excludes raw invitation code, cookie token, and password.
- Confirm guest UI and API expose only owner/self direct projection and no invitation management controls.
- Confirm hub call REST/realtime/outbox/audit projections contain only owner and the selected spoke, with no hub name, count, other identity, provider room, token, key, or secret.
- Decode test join tokens and confirm random identity, exact room, short expiry, microphone/camera-only source grants, no data/admin/create/record grants, and different identities per user.
- Confirm scheduled meetings bind to a real event occurrence and snapshot only the exact authorized attendees; a forged occurrence or future membership is rejected.
- Confirm waiting users receive no token, attendees receive `canPublish=false`, and live speaker demotion unpublishes tracks and removes microphone/camera controls.
- Confirm meeting REST/realtime/outbox projections contain random media identities only for exact visible participants and omit provider room, token, key, secret, and hidden-hub roster information; audit omits all provider identifiers.
- Confirm recording requests snapshot only joined participants, reject policy mismatch, require every grant, block non-snapshot joins, and permit immediate participant revoke.
- Confirm recording REST/realtime/audit projections omit provider Egress ID, provider room, object key, storage credentials, JWTs, and webhook signature material.
- Confirm invalid Egress signatures and wrong webhook content types fail, duplicate states do not multiply durable events, and uncertain provider stop deletes the room and fails the session closed.
- Confirm production media manifests reject `ws`, loopback/private public endpoints, placeholder secrets, insecure object storage/webhooks, missing TURN/TLS, and a signaling-shared TURN hostname.
- Confirm LiveKit and Egress render the exact same authenticated Redis address, generated summaries contain no secret values, and smoke management/object ports bind only to loopback.
- Confirm a real Egress worker can write an MP4 but cannot read or delete it, anonymous retrieval fails, retention matches policy, and cleanup leaves no provider room or smoke object.
- Confirm session cookies contain `HttpOnly` and `SameSite=Strict`, API JSON contains no token, and PostgreSQL contains only a 32-byte digest.
- Exhaust an authentication bucket, restart the API, and confirm the same digest-only bucket remains blocked without storing email/IP plaintext.
- Export audit records containing planted body/token/participant secrets and confirm content, DB projection, metrics, and release artifacts contain none of them.
- Compare operations API results for owner, admin, member, deleted member, and another organization; repeat direct SQL under a non-superuser/no-`BYPASSRLS` role with no context and two different organization contexts.
- Prove an active legal hold blocks approval and execution, the requester cannot approve their own destructive job, and a released hold plus a different administrator is required.
- Restore a custom-format PostgreSQL dump into a separate database and compare migration, organization, user, audit, release, lifecycle, and RLS-policy invariants.
- Run bounded concurrent message/idempotency and authenticated Socket.IO reconnect tests; fail on errors, duplicates, or explicit p95 thresholds.
