# Stage 2A Auth And Persistence

## Scope

Stage 2A establishes a durable identity boundary before conversation persistence. PostgreSQL stores accounts, organization membership, profiles, sessions, and authentication audit events. Existing messages, invitations, and attachment metadata remain demo-memory state until Stage 3 and must not be described as durable.

## Runtime Contract

1. `apps/api/migrations/*.sql` are immutable, ordered migrations. The runner records a SHA-256 checksum and serializes startup with a PostgreSQL advisory lock.
2. Passwords use Argon2id with 19 MiB memory, two iterations, and one lane. Plaintext passwords never enter logs, responses, or Obsidian reports.
3. Login creates 32 random bytes encoded as an opaque cookie value. PostgreSQL stores only its SHA-256 digest in `web_sessions`.
4. Sessions have a 12-hour absolute lifetime and a two-hour idle lifetime. Activity refresh is write-throttled to five-minute intervals.
5. The cookie is `HttpOnly`, `SameSite=Strict`, host-only, and path `/`. Remote HTTPS deployment must set `COOKIE_SECURE=true`; the current desktop loopback runtime uses HTTP on `127.0.0.1` and a dedicated cookie name.
6. Every protected HTTP handler receives a server-resolved principal. Query/body fields such as `viewerId`, `senderId`, `uploaderId`, `invitedBy`, and confirmation `userId` have no authority.
7. Socket.IO authenticates the same cookie during handshake and joins only `user:<authenticated-id>`.
8. Unsafe browser requests require the exact configured Origin and `X-HahaTalk-Client: web-v1` in addition to strict credentialed CORS.

## Local Infrastructure

Preferred shared stack:

```powershell
npm run infra:up
npm run infra:status
```

Windows PostgreSQL-only fallback when Docker Desktop cannot start its WSL VM:

```powershell
npm run infra:postgres:portable
npm run infra:postgres:portable:stop
```

The fallback downloads PostgreSQL 18.4 from the EDB archive linked by postgresql.org, verifies the pinned archive SHA-256, and stores binaries/data under `%LOCALAPPDATA%\HahaTalkDev`. No database binary or local credential is committed.

The Compose MinIO image is pinned to its last documented binary line, bound to loopback, and allowed only for local development. The MinIO community repository was archived in 2026 and no longer publishes maintained community binaries, so Stage 5 must choose an active S3-compatible implementation or managed S3 before production media storage.

## Verification

```powershell
npm run build -w apps/api
npm run auth:integration
```

The integration harness creates a fresh temporary database, applies every migration, proves unauthenticated HTTP/Socket.IO denial, missing-Origin denial, Argon2id storage, HttpOnly/Strict cookie attributes, absence of a token field, 32-byte server digest storage, participant `viewerId` spoof denial, HTTP and Socket.IO `senderId` spoof denial, API restart restoration, and logout revocation, then drops the temporary database.

## Stage 2B Remaining

- invitation/email proof instead of demo account claiming or open registration
- device/session list, rotation, revoke-all, and risk events
- Redis-backed login throttling and abuse controls
- passkeys and enterprise SSO adapters
- approval quorum and policy-versioned consent records
- secure account recovery and verified email change

## Primary References

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [NestJS authentication](https://docs.nestjs.com/security/authentication)
- [NestJS authorization](https://docs.nestjs.com/security/authorization)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
- [Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)
- [PostgreSQL Windows downloads](https://www.postgresql.org/download/windows/)
- [MinIO archived source repository](https://github.com/minio/minio)
