# Stage 2B Invitations, Consent, And Guest Approval

## Scope

Stage 2B replaces the Stage 1 memory invite affordance with a PostgreSQL state machine. It supports new guest activation, existing-account acceptance, manager/all-member/quorum approval, policy-versioned consent evidence, invitation audit events, device-session revoke, and rate-limited public endpoints.

External email delivery is not simulated. The manager receives the raw invitation code once and must deliver it through an approved side channel. SMTP/provider integration is a deployment task.

## Storage Contract

- `invitations`: invitee email/user, requested role, policy, required count, status, token digest, expiry, use count, invitee decision, activation/revoke evidence.
- `invitation_approval_requirements`: eligible approver snapshot at creation time.
- `invitation_approvals`: one immutable decision per required approver.
- `consent_records`: terms, privacy, and group-join decision with policy version and non-secret evidence.
- `audit_logs`: created, approved/rejected, invitee accepted/declined, activated, revoked, and expired events.
- `web_sessions`: device list and user-driven revocation.

The raw `hti_...` code is generated from 32 random bytes, returned only by create, and never stored or logged. PostgreSQL stores a SHA-256 digest until the code is consumed, revoked, or expired.

## State Machine

```text
create
 -> pending_approval or sent
 -> invitee accepts (code consumed)
 -> pending_approval when approvals remain
 -> accepted only when invitee acceptance + approval threshold are both complete

active code -> declined | revoked | expired
accepted/declined/revoked/expired -> terminal
```

`SELECT ... FOR UPDATE` serializes accept/decision/revoke. Quorum rejection becomes terminal only when the remaining possible approvals cannot reach the required count. Once the threshold is complete, a late decision cannot reverse it.

## Privacy Projection

- Owner/authorized manager: email, policy, required/approved count, status, revoke action.
- Required hidden-hub approver: invitee email/role, own decision action, status. No approver roster, aggregate count, policy, or group size.
- Guest/non-participant: no invitation enumeration.
- Accepted guest conversation: owner/self only, direct title, no group roster or manager controls.

## API

- `GET /invitations`
- `POST /invitations`
- `POST /invitations/preview` (public, throttled)
- `POST /invitations/accept` (public or matching authenticated account, throttled)
- `POST /invitations/decline` (public, throttled)
- `POST /invitations/:id/decision`
- `POST /invitations/:id/revoke`
- `GET /auth/sessions`
- `POST /auth/sessions/:id/revoke`
- `POST /auth/sessions/revoke-others`

All state-changing calls still require exact Origin and `X-HahaTalk-Client: web-v1`. Actor IDs are never accepted from request bodies.

## Verification

`npm run invitation:integration` creates a fresh database and verifies digest-only storage, missing-consent denial, guest activation, pending approval, minimal approver projection, rejection, quorum completion, expiry, revoke, replay denial, exactly-one concurrent acceptance, consent/audit rows, device revoke, and throttling.

`npm run desktop:renderer-smoke` drives the installed UI through owner login, invitation creation, logout, invitation preview, three explicit consents, guest activation, guest login, direct projection, guest label, manager-control absence, screenshot, logout, and clean process shutdown.
