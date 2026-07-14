# Stage 9: Consented Remote Support

## Scope

Stage 9 adds an attended remote-support control plane for HahaTalk Windows. It is not an unattended remote desktop service.

- The requester and target must be internal organization members.
- Both people must be joined to the same private two-person ad-hoc call.
- A hidden hub session must include the hub owner; two unrelated spokes cannot support each other through the hidden hub.
- The target must already be sharing a screen through the existing LiveKit flow.
- `screen_view` and `remote_control` require independent target decisions.
- `clipboard` and `file_transfer` are modeled but fail closed in this stage.
- Guests, subscribers, multiparty calls, broadcast sessions, and background access are rejected.

## Security Model

The browser renderer never receives operating-system input privileges. After all requested scopes are granted, the target can issue a one-time activation secret and start a separate Electron utility process. The API stores only SHA-256 token digests.

Every input command has:

- a server-assigned sequence;
- a control epoch;
- a short expiration time;
- a narrow command kind and normalized payload;
- claim and completion state tied to one agent credential.

Pause, revoke, emergency stop, expiry, and session termination increment the control epoch, revoke active agent credentials, and cancel queued or claimed commands. The API checks absolute and idle expiry on both user reads and every agent heartbeat, claim, or completion path. A resume returns to `approved` and requires a fresh one-time activation.

## Agent Gate

The bundled Stage 9 agent runs in `dry_run` mode. It independently validates the command allowlist and reports `simulated`, but it cannot call Windows input APIs. Real `SendInput` execution remains fail closed until all of these external conditions are met:

1. a reviewed native Windows agent is built for the interactive user session;
2. the binary and installer are Authenticode signed by Inviz;
3. signature verification and update provenance are enforced at launch;
4. accessibility, abuse, incident-response, and legal reviews approve production use;
5. a physical two-PC test proves the target's pause and emergency stop paths.

UAC secure desktop, integrity-level bypasses, hidden services, shell/script execution, and arbitrary file paths are explicitly out of scope.

## Data Model

- `remote_support_sessions`: exact organization, space, call, requester, target, scopes, status, epoch, and absolute/idle expiry.
- `remote_support_consents`: one policy-versioned decision per requested scope.
- `remote_support_agent_credentials`: one-time activation and short agent bearer digests; plaintext is never persisted.
- `remote_support_commands`: idempotent allowlisted commands with sequence, epoch, TTL, claim, and result.
- `remote_support_events`: append-only lifecycle and command-state evidence.
- `audit_logs`: high-level security actions without credential or command payload contents.

## API Surface

User routes are under `/remote-support`. The utility agent uses `/internal/remote-support`, authenticated with the one-time activation marker and then a short bearer token. Internal agent routes are accepted by the origin policy only when the dedicated agent header is present; every route still validates the secret or token digest.

## Verification

```powershell
npm run remote-support:integration
npm run desktop:stage9-renderer-smoke
```

The integration harness creates a fresh database and verifies private-call context, hidden-hub owner isolation, scope consent, token replay denial, digest-only storage, command allowlisting, idempotency, TTL, epoch fencing, pause/resume/emergency stop, restart recovery, guest and multiparty denial, agent-enforced idle expiry, audit coverage, realtime recipient privacy, and chat independence.

The installed renderer smoke launches the packaged Windows application, starts the Electron utility agent through the preload bridge, performs a dry-run command round trip, pauses from the target UI, checks process/runtime cleanup, and captures the final panel.
