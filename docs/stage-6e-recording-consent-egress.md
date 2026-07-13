# Stage 6E Recording Consent And LiveKit Egress

## Scope

Stage 6E adds consent-gated MP4 room recording to active ad-hoc calls and scheduled meetings. It covers request, unanimous consent, start, visible active state, immediate stop or consent revoke, provider reconciliation, protected object output metadata, and fail-closed behavior. Playback, retention controls, transcript generation, AI summaries, and external sharing are later stages.

## Consent Contract

The policy version is `hahatalk-recording-v1`.

- Only an ad-hoc call host or scheduled meeting host/cohost can request and start recording.
- The request snapshots every participant whose durable media status is `joined`, including guests and the requester.
- Every snapshotted participant must grant the exact policy version before start.
- A denial closes that request. A new request creates a new snapshot and new append-only evidence.
- A participant who granted consent can revoke while recording. A host/cohost can stop for everyone.
- A user outside the consent snapshot cannot join until the open recording cycle ends.
- Initial participant JWTs never include `roomRecord`; Egress credentials remain server-side.

`consent_records` stores append-only `granted`, `denied`, and `revoked` evidence scoped to one `call_recording`. `call_recording_participants` is the per-request roster and current response projection. `call_recordings.consent_snapshot_json` freezes the final granted record IDs before provider start.

## Lifecycle

The durable states are:

`consent_pending -> consent_granted -> starting -> recording -> stopping -> ready`

Terminal alternatives are `consent_denied`, `failed`, and `aborted`. `processing` is reserved for a provider or post-processing handoff. One partial unique index permits only one pending or active request per media session.

Provider calls happen outside database transactions. The API records intent first, applies the returned provider state in a second transaction, and reconciles nonterminal provider IDs every five seconds. If a process stops between Egress creation and ID persistence, a signed webhook or a unique active Egress lookup by the random provider room repairs that binding; an unmatched start intent fails closed after a bounded wait. Signed `egress_started`, `egress_updated`, and `egress_ended` webhooks use the untouched request body and LiveKit SHA-256/JWT verification. Duplicate provider states do not create repeated audit/outbox records.

If Egress stop is uncertain, HahaTalk attempts to delete the LiveKit room, marks the recording and media session failed, invalidates participant tokens, and records `recording.fail_closed`. The UI reports that the media session ended; it never pretends recording stopped safely.

## Provider And Storage

The production adapter uses LiveKit Room Composite Egress with grid layout, H.264 720p/30, MP4 output, and S3-compatible protected storage. Object keys are generated server-side as:

`recordings/<organization>/<session>/<recording>.mp4`

The client receives no provider Egress ID, provider room name, object key, storage credential, or signed object URL. Stage 6E exposes only consent and lifecycle projections. A deterministic in-memory Egress driver exists only under `NODE_ENV=test` for failure and state-machine harnesses.

Required production configuration:

- `LIVEKIT_EGRESS_ENABLED=1`
- `LIVEKIT_EGRESS_S3_BUCKET`
- `LIVEKIT_EGRESS_S3_REGION`
- `LIVEKIT_EGRESS_S3_ACCESS_KEY`
- `LIVEKIT_EGRESS_S3_SECRET_KEY`
- optional S3 endpoint, path-style, session token, and HTTPS webhook URL

Self-hosted Egress is a separate service and must share Redis connectivity with LiveKit. It is not bundled into the Windows client. The embedded Windows API is a local MVP verification runtime, not a place to distribute production LiveKit or S3 credentials; external service credentials must remain in a centrally managed backend and secret manager. A real deployment smoke test remains blocked until a Linux/Docker Egress runtime and protected S3-compatible bucket are available.

## UI Contract

- A compact `녹화 요청` control appears only for a joined moderator while no request is open.
- The consent panel names every snapshotted participant and shows pending, granted, denied, or revoked state.
- Consent and denial are separate explicit commands; no call or meeting action implies consent.
- `REC 녹화 중` is red and continuously visible while the provider state is active.
- A participant has immediate `동의 철회`; a moderator has `녹화 중지`.
- Realtime notifications contain only the media-session ID, then the authenticated client fetches its viewer-safe projection.

## Verification

Fresh-database call and meeting harnesses prove exact roster snapshots, moderator boundaries, policy mismatch rejection, denial and fresh request, unanimous consent, cohost start, participant revoke, late-join blocking, append-only consent evidence, restart persistence, signed webhook enforcement, provider-secret exclusion, and fail-closed room deletion.

The full project harness also runs type checks, builds, schema checks, existing privacy/invitation/media/calendar regressions, Windows runtime checks, and package smoke tests before commit and push.

## Official References

- [LiveKit Egress overview](https://docs.livekit.io/home/egress/overview/)
- [Room composite recording](https://docs.livekit.io/home/egress/room-composite/)
- [Egress API](https://docs.livekit.io/home/egress/api/)
- [LiveKit webhooks](https://docs.livekit.io/home/server/webhooks/)
- [Self-hosting Egress](https://docs.livekit.io/home/self-hosting/egress/)
- [LiveKit Egress source](https://github.com/livekit/egress)
