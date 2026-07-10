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
| Manipulated client targets another participant | Resolve deliveries server-side; non-owner hub messages normalize to owner only |
| Shared socket leaks full message | User-specific authenticated channels and per-viewer projection |
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
