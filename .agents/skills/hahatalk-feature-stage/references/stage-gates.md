# HahaTalk Stage Gates

## Conversation

- Direct chat exposes only two identities.
- Open group exposes the shared roster and shared timeline.
- Hub owner sees all spokes and recipient reports.
- Hub participants see the owner as a 1:1 counterpart, no other identity/count/presence/read state, and only their own delivery projection.
- Broadcast subscribers cannot publish unless promoted.

## Identity And Invitations

- Initial relationship requires inviter and invitee acceptance.
- Managed-group joins follow the configured owner/admin/all-member/quorum policy plus invitee acceptance.
- Expired or revoked invitations cannot be reused.

## Media

- The original asset has an owner and archive scope.
- Sharing creates a separate grant; it does not change private ownership.
- Capture date, timezone, and place are indexed when available.
- GPS is stripped from public derivatives unless the owner explicitly keeps it.

## Calls And Broadcasts

- Scheduled and ad-hoc sessions use the same call state model.
- Camera, microphone, screen share, recording, and background processing have visible state and stop controls.
- Recording requires a consent snapshot.

## AI Voice

- STT and TTS are queued and retryable.
- Transcript and summary output is marked as an AI draft until reviewed.
- Voice cloning requires an active voice-profile consent record, revocation, audit, and watermark policy.

## Remote Support

- View consent and control consent are distinct and session-scoped.
- Control cannot start from stale approval.
- The target user can pause or end immediately.
- Every capability change writes an audit event.

## Completion

- Primary-source research recorded.
- Contract and schema updated.
- Positive, denial, and leakage tests pass.
- Typecheck, tests, build, smoke, and feature harness pass.
- Running flow inspected.
- Obsidian report, prompt log, decision log, and learning page updated.
- Focused commit pushed and recorded.
