# Stage 11 Hardening and Release

HahaTalk 0.18.0 adds the release-candidate control plane. It does not claim production GA: signing identities, mobile store credentials, physical-device evidence, public infrastructure, legal approval, and the Stage 6F real Egress MP4 remain external gates.

Stage 11 uses immutable migration `015_release_hardening.sql` for the seven operations tables and additive migration `016_release_hardening_lifecycle_concurrency.sql` for the organization-singleton export-expiry execution fence. The validated schema remains 77 tables.

## Implemented

- PostgreSQL-backed fixed-window throttling for HTTP and Socket.IO message/join/typing paths
- code-defined, low-cardinality Prometheus metrics plus liveness and schema-aware readiness
- organization-authorized audit exports with pseudonymous references, recursive redaction, digest verification, short expiry, and private object storage
- versioned retention policies, scoped legal holds, idempotent lifecycle jobs, second-administrator approval, dry-run, single-active restartable export expiry, and account deletion limited to a user with exactly one active organization membership
- `FORCE ROW LEVEL SECURITY` on all new organization operations tables with transaction-local organization context
- release candidate, immutable gate evidence, pending-external status, staged rollout fencing, and rollback records
- real `pg_dump` custom archive and isolated `pg_restore` invariant verification
- bounded message/idempotency load and authenticated Socket.IO reconnect thresholds
- release manifest, CycloneDX SBOM, GitHub Actions artifact upload, and conditional public-repository provenance attestation

## Security Boundaries

- metrics never use user, organization, room, message, filename, object key, provider identity, or token labels
- export records contain pseudonymous actor/target references and never expose message bodies, names, emails, IPs, tokens, object keys, participants, transcripts, or provider identifiers
- destructive account lifecycle is disabled unless `HAHATALK_DESTRUCTIVE_LIFECYCLE_ENABLED=true`; actual jobs still require a different owner/admin approver and no active legal hold
- logical deletion revokes credentials, sessions, devices, push work, media projection, and voice consent while business messages/audit evidence remain pseudonymized records pending approved legal policy
- production readiness rejects a superuser or `BYPASSRLS` database role; local embedded development reports that limitation explicitly

## Verification

- `npm run release:artifact-check`
- `npm run release:integration`
- `npm run release:load`
- `npm run release:quality`
- `npm run release:manifest -- --require-desktop`
- `npm run release:sbom`

External gates must stay `pending_external` until their evidence digest is recorded. A candidate cannot begin rollout while any external gate is pending, and rollback always returns rollout to zero.
