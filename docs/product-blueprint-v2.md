# HahaTalk Product Blueprint V2

## Product Thesis

HahaTalk keeps the familiarity of KakaoTalk while adding an owner-centered communication model for families, customer service, sales, education, and field support. It is one product with four deliberately separate social contracts: private chat, open group, hidden-roster hub, and personal broadcast.

## Core Experiences

### Direct Chat

Two people see the same 1:1 timeline. Photos, files, voice messages, calls, schedules, reactions, and support requests remain in that relationship context.

### Open Group

This is the familiar group room. Every active member can see the roster and shared conversation. Roles can moderate invitations, files, calls, and broadcasts.

### Owner-Centered Hub

The owner sees a console containing many private spokes. The owner can:

- talk to one participant
- send one logical message to selected participants
- publish an announcement to all participants
- inspect recipient-specific delivery, read, and confirmation state

Every participant sees only a normal 1:1 chat with the owner. They do not see a group name, member count, member list, other replies, presence, read state, or target list. A reply always returns only to the owner.

### Personal Broadcast

A creator can schedule or start a LiveKit-backed video/audio broadcast. Subscribers see a channel, live room, moderated chat, aggregate reactions, and a replay only after trusted Egress succeeds. Broadcast membership is separate from chat-room membership. Viewers are hidden subscribe-only media participants and never see one another; only host/cohost/speaker identities are public on stage. A viewer can request a private service handoff, which creates or reuses a separate 1:1 conversation rather than leaking that exchange into the broadcast.

## Identity, Family, And Managed Groups

- A user account is independent from organization membership.
- The first connection requires inviter and invitee acceptance.
- Joining an existing managed group requires the invitee plus the configured owner/admin/all-member/quorum approval policy.
- Personal collections such as family, customers, or service cohorts can remain owner-only so grouping itself is not disclosed.

## Media Memory

Each photo/video is first an owned media asset, then optionally shared through a separate grant. This supports:

- `private_archive`: keep only for myself
- `shared`: share to the current conversation
- `selected`: share to chosen recipients
- grouping by capture date, local timezone, place, and album
- owner-centered search and timeline
- GPS-stripped derivatives for safer sharing

## Calls, Avatar, And Voice

- Ad-hoc and scheduled voice/video sessions share one call state model.
- A profile photo can produce a static caricature first, an expression set second, and an animated avatar later.
- Background modes are none, blur, image, or avatar, subject to device capability.
- STT records a draft, lets the sender edit it, and sends only after approval.
- TTS uses a standard Korean voice by default. A real-person voice profile is a separate, consented, revocable biometric feature.

## Reactions And Emoticons

Sticker packs are organized by emotion, celebration, comfort, work, and custom themes. Every sticker has an accessibility label. Fast work reactions such as confirm, done, question, urgent, thanks, congratulations, and comfort remain one-click actions.

## Service Professional Mode

Customer support and field-service users receive a dedicated workflow:

- appointment and reminder
- voice/video call
- screen share
- remote-view request
- separate remote-control approval
- visible session status and emergency stop
- file transfer and clipboard permissions as independent grants
- full audit timeline and session summary

Windows remote support is implemented first. Mobile clients support viewing, guidance, and screen sharing according to OS limits; they do not promise unrestricted device control.

## Product Ideas Added

- Hub inbox: owner groups spokes by unread, urgent, waiting-for-me, and scheduled follow-up.
- Announcement receipt: one logical announcement with per-recipient read/confirm report.
- Relationship memory: permitted files, schedules, summaries, and photos remain searchable per person.
- Shared-to-private promotion: an owner can receive a participant asset privately and explicitly republish a safe derivative.
- Broadcast-to-chat handoff: a viewer can request a private service chat without exposing other viewers.
- Consent center: users can inspect and revoke recording, transcript, avatar source, voice profile, and remote-support grants.
- Voice safety: generated speech is watermarked and visibly marked as synthesized when a cloned profile is used.
