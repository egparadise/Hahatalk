# Stage 6B LiveKit Call Core

## Scope

Stage 6B adds Windows-first ad-hoc voice and video calls to direct, open-group, and hidden-hub conversations. It does not include scheduled meeting roles, screen sharing, device selection, background processing, recording, STT/TTS, or broadcasting.

## State And Storage

- Migration `007_livekit_call_core.sql` creates `call_sessions`, `call_participants`, and append-only `call_events`.
- Call state moves through `starting`, `ringing`, `active`, and terminal `ended`, `cancelled`, `failed`, or `expired` states.
- Participant state is independent: `invited`, `connecting`, `joined`, `declined`, `left`, `removed`, or `missed`.
- `idempotency_keys` protects call start. `outbox_events` stores only recipient-specific safe projections for `call:incoming` and `call:updated`.
- LiveKit API secrets and join tokens are never stored in PostgreSQL, outbox, audit, logs, or runtime status.

## Authorization And Privacy

- Direct calls resolve to the current counterpart regardless of a forged target.
- Open-group calls snapshot either the explicit active targets or all current active members, capped at 16 total participants in this stage.
- A hub participant may call only the owner. A hub owner must select exactly one spoke.
- Stage 6B deliberately rejects a hub owner selecting multiple spokes. LiveKit identities are visible within one provider room, so privacy-preserving multi-spoke calls need one room per owner-spoke edge and a later bridge/mixer.
- Provider room names and media identities are random per call. Ordinary API and realtime projections omit the provider room. A viewer sees only exact call participants they are authorized to know.
- Guests may accept an exact call invitation but may not initiate calls.

## LiveKit Boundary

- The API requires all of `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`; partial, invalid, or insecure non-loopback configuration is unavailable.
- Join tokens expire after 120 seconds for initial connection and grant only room join, subscribe, and the media sources required by the call type.
- Voice permits microphone. Video permits microphone and camera. Data, screen share, metadata mutation, room creation, room admin, and recording are denied.
- `POST /calls/:id/join` changes the app participant to `connecting` and returns the ephemeral token. `POST /calls/:id/connected` changes durable state only after the LiveKit client connects.
- A local Windows binary proves development behavior. Production needs trusted TLS plus TURN/TLS for restrictive networks.

## API

- `GET /calls/capabilities`
- `GET /calls?spaceId=<uuid>`
- `GET /calls/:callId`
- `POST /calls`
- `POST /calls/:callId/join`
- `POST /calls/:callId/connected`
- `POST /calls/:callId/decline`
- `POST /calls/:callId/leave`
- `POST /calls/:callId/end`

## PC Experience

- Phone and camera icons start or reopen the current call and are disabled when the provider is unavailable.
- The full workspace call desk shows incoming, connecting, active, reconnecting, ended, and retryable error states.
- Remote audio tracks attach automatically. Video and character fallback tiles have stable dimensions.
- The user can mute/unmute microphone, enable/disable camera, decline, leave, or end for everyone when host.
- LiveKit client code is dynamically imported only when a call is accepted or started.

## Verification

```powershell
npm run infra:postgres:portable
npm run infra:livekit:portable
npm run calls:integration
npm run desktop:call-renderer-smoke -- --executable=<installed HahaTalk.exe>
```

The fresh-database suite verifies real provider room creation, scoped JWT claims, direct/group/hub authorization, realtime incoming events, idempotency, guest restrictions, restart persistence, provider failure, terminal cleanup, audit, and secret non-disclosure. The installed renderer suite uses Electron's test-only fake media device to prove an actual SFU join, rendered camera frames, microphone control, layout, leave, and provider-room deletion.
