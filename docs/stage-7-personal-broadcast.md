# Stage 7 Personal Broadcast

Stage 7 adds a Windows-first personal broadcast desk without turning channel subscribers into chat-room members. A channel owner can create a channel, schedule a voice/video broadcast, start a LiveKit room, moderate questions, promote a connected viewer to the stage, demote them immediately, and end the room. Subscribers receive a viewer-safe projection, reactions, moderated Q&A, and an explicit handoff to a separate private conversation.

## Researched Provider Rules

The implementation follows LiveKit's documented server grants and participant controls:

- [Access tokens](https://docs.livekit.io/home/server/generating-tokens/) support `canSubscribe`, `canPublish`, publication-source limits, and hidden participants.
- [Participant management](https://docs.livekit.io/home/server/managing-participants/) supports live permission updates and immediate removal.
- [Livestreaming](https://docs.livekit.io/home/client/tracks/livestreaming/) treats the media room as one or a few publishers with many subscribers.
- [Egress](https://docs.livekit.io/home/egress/overview/) is the trusted path for MP4/HLS/RTMP output; the desktop renderer is not a recording authority.
- [Webhooks](https://docs.livekit.io/home/server/webhooks/) are delivery-at-least-once lifecycle evidence and must be verified and reconciled rather than treated as a single infallible event.

## Privacy Model

`broadcast_channels` and `channel_subscriptions` are independent from ordinary conversation membership. The owner receives a channel/studio view. A subscriber receives only:

- channel identity, owner identity, and subscriber count;
- the current scheduled/live/ended session;
- on-stage host/cohost/speaker identities;
- published chat and their own pending messages;
- aggregate reaction counts.

A subscriber never receives another viewer's identity or the moderation participant roster. Viewer tokens are `hidden`, `canSubscribe=true`, and `canPublish=false`. Promotion changes both the durable role and provider permission; demotion revokes tracks and returns the participant to hidden subscribe-only state. Any provider update uncertainty fails the role operation closed.

## Durable Data

Migration `011_personal_broadcast.sql` adds:

- `broadcast_channels` and `channel_subscriptions`;
- `broadcast_sessions` tied one-to-one to a `call_sessions` broadcast room;
- `broadcast_messages`, `broadcast_reactions`, and `broadcast_moderation_actions`;
- `broadcast_replays`, `broadcast_private_handoffs`, and `broadcast_events`.

Every schedule and message command carries a client idempotency key. Moderation and role changes use optimistic versions. Audit events record channel creation, subscription changes, lifecycle transitions, messages, moderation, roles, and private handoffs. Realtime notifications contain only opaque channel/session IDs and cause each authenticated client to fetch its own projection.

## API Surface

- `GET /broadcasts` and `GET /broadcasts/capabilities`
- `POST /broadcasts/channels`
- `POST /broadcasts/channels/:id/subscribe`
- `DELETE /broadcasts/channels/:id/subscription`
- `POST /broadcasts/channels/:id/sessions`
- `POST /broadcasts/channels/:id/private-handoff`
- `GET /broadcasts/sessions/:id`
- `POST /broadcasts/sessions/:id/start|join|connected|leave|end`
- `PATCH /broadcasts/sessions/:id/participants/:userId/role`
- `POST /broadcasts/sessions/:id/participants/:userId/moderate`
- `POST /broadcasts/sessions/:id/messages`
- `PATCH /broadcasts/sessions/:id/messages/:messageId/moderate`
- `POST /broadcasts/sessions/:id/reactions`

## Windows Work Desk

The fourth rail destination opens a dense broadcast workspace:

- channel list, live state, subscription count, and notification setting;
- owner channel creation and schedule dialogs;
- full-height video/voice stage with real LiveKit media;
- host/cohost/speaker microphone and camera controls;
- viewer chat, moderated anonymous questions, reactions, and private-service handoff;
- owner-only question queue, stage roles, remove, and block operations;
- independent broadcast pop-out window;
- explicit loading, empty, reconnect, error, ended, and replay-unavailable states.

## Replay Boundary

Stage 7 stores replay intent and status but does not claim a replay exists unless trusted central Egress produces a protected media asset. When the Stage 6F Egress gate is unavailable, ending a requested replay produces `unavailable`, not a synthetic success or local renderer file. Analytics beyond live viewer count and reaction totals remain a later release concern.

## Verification

`npm run broadcasts:integration` creates a fresh database and a pinned official LiveKit server. It verifies channel/subscription separation, unlisted discovery, idempotent scheduling, hidden tokens, lifecycle, moderated Q&A, anonymous projection, reactions, private handoff, blocking, role failure recovery, restart behavior, audit/outbox evidence, and replay fail-closed behavior.

`npm run desktop:broadcast-renderer-smoke` runs the installed `0.14.0` application with embedded PostgreSQL and real LiveKit signaling. It proves:

- the viewer is hidden and subscribe-only at the provider;
- no viewer roster or management UI is disclosed;
- a renderer question enters the host queue and publishes in real time;
- reactions persist;
- live promotion enables publishing and renders a fake camera frame;
- demotion removes the track, controls, and visible-provider status;
- stage/header/control geometry does not overlap at the desktop viewport;
- ending removes the provider room and replay fails closed;
- Electron and embedded PostgreSQL stop cleanly.

The installed-renderer screenshot is written to `apps/desktop/out/stage7-personal-broadcast.png` and remains a generated artifact rather than source control input.
