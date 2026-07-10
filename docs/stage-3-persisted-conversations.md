# Stage 3 Persisted Conversation Core

## Goal

Stage 3 replaces the in-memory conversation path with a PostgreSQL source of truth while preserving HahaTalk's defining privacy rule: a hub owner sees one multi-person console, but each participant sees only a normal 1:1 conversation with the owner.

## Runtime Contract

- `conversation_spaces` stores direct, open-group, and hub conversations.
- `space_memberships` stores role, viewer mode, mute state, and the monotonic last-read cursor.
- `hub_spokes` records the owner-to-participant relationship without creating shared participant visibility.
- `messages`, `message_audiences`, and `message_deliveries` separate author intent from the immutable recipient snapshot.
- `idempotency_keys` makes a repeated `clientMessageId` return the original message and rejects key reuse with different content.
- `outbox_events` is written in the same transaction as each message. Each row contains exactly one internal recipient id.
- Socket.IO is a low-latency notification path. Reconnect always reloads the authoritative timeline from PostgreSQL.

## Privacy Rules

1. Every read query joins or checks `message_deliveries` for the authenticated internal user id.
2. A hub participant's attempted audience is normalized to the owner, regardless of client-supplied targets.
3. A hub participant receives only the owner and self in the room projection.
4. Participant events are emitted only to `user:<public-user-id>`; there is no shared hub socket room.
5. Search uses the same delivery boundary and cannot reveal hidden messages.
6. Public ids cross the API boundary. Database UUIDs remain server-side.

## API Surface

- `GET /mvp?spaceId=`: selected conversation plus conversation list.
- `GET /spaces`: viewer-safe conversation summaries and unread counts.
- `GET /spaces/:spaceId/view?before=&limit=`: delivery-scoped keyset timeline.
- `GET /spaces/:spaceId/search?q=`: delivery-scoped text search.
- `POST /messages`: idempotent message creation.
- `PATCH /messages/:messageId`: author-only edit.
- `DELETE /messages/:messageId`: author or room-manager delete.
- `POST /messages/:messageId/read`: monotonic read state.
- `POST /messages/:messageId/confirm`: explicit confirmation without rewriting read time.
- `GET /messages/:messageId/read-report`: sender/owner/admin report.

## Realtime Events

- `message:created`
- `message:updated`
- `message:deleted`
- `message:delivery-updated`
- `typing:updated`

The local publisher marks an outbox row after emission. Duplicate delivery after a crash is harmless because clients upsert by message id. Horizontal deployment requires a leased/claimed outbox worker before multiple publisher instances are enabled.

## Verification

`npm run conversation:integration` creates a fresh database, applies all migrations, claims four seeded users, and verifies hub privacy, direct/group behavior, idempotency including concurrent duplicates, keyset pagination, monotonic reads, confirmation, reply/edit/delete/search, outbox shape, Socket.IO and typing isolation, and API restart persistence.

The Windows renderer smoke additionally clicks through room switching, persisted send, edit, reply, search, and delete in the installed Electron application.
