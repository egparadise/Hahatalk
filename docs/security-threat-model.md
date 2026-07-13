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
| Ended self-hosted token reconnects | Stop token issuance at terminal app state, increment participant token version, delete provider room, and keep join TTL short |
| Invitation database reveals usable code | Return raw code once; store only a 32-byte SHA-256 digest; never log it |
| Invitation is replayed or accepted concurrently | `SELECT FOR UPDATE`, use count 1, token digest scrubbing, terminal status checks |
| Client fakes approval or approval count | Snapshot eligible approvers server-side and derive progress from immutable decisions |
| Hidden hub approver learns roster/count | Minimal approver projection omits policy, aggregate count, approver list, and group size |
| Uninvited user uses open signup | Production default denies arbitrary signup; only one-time bootstrap flags or invitation activation |
| Brute-force invitation/login attempts | Route-specific Nest throttling; Redis storage required before multi-node deployment |
| Duplicate message/upload/job | Idempotency key and unique constraint |
| DB commit succeeds but realtime fails | Transactional outbox and retry worker |
| Private photo becomes shared original | Separate owned asset from share grant; safe derivative and revoke |
| GPS unintentionally disclosed | Default GPS-stripped derivative and explicit keep-location choice |
| Recording starts without consent | Current consent snapshot before egress and visible recording state |
| Voice impersonation | Purpose-specific subject consent, encrypted embedding, watermark, audit, revoke/delete |
| Remote control uses stale approval | Session-scoped short expiry, separate control grant, target emergency stop |
| Electron renderer reaches native control | Context isolation, narrow preload API, signed separate support agent |
| AI output treated as fact | `ai_draft` state, review workflow, source links, retry/failure state |

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
- Confirm session cookies contain `HttpOnly` and `SameSite=Strict`, API JSON contains no token, and PostgreSQL contains only a 32-byte digest.
