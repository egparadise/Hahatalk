# Stage 6F Trusted Media Infrastructure

## Scope

Stage 6F turns the Stage 6E recording adapter into a reproducible central-service deployment contract. It covers configuration rendering, validation, a local Linux-container smoke stack, private recording storage, retention, and a strict real Room Composite MP4 test. It does not claim that loopback Compose is a production deployment.

## Trust Boundary

- End-user web, Windows, Android, and iOS clients receive short-lived participant tokens only.
- LiveKit API secrets, Redis credentials, Egress S3 credentials, storage administration credentials, and webhook configuration exist only in central services or a deployment secret manager.
- LiveKit and every Egress worker use the same authenticated Redis address and password.
- Egress is a separate, isolated worker. Its storage principal can upload only under `recordings/*`; it cannot list, read, or delete recordings.
- Future playback and deletion use a different API-side principal and an audited authorization path.

## Deployment Manifest

`infra/media/deployment.production.example.json` is deliberately invalid until an operator replaces every `.invalid` endpoint and injects strong secrets through environment variables. The renderer fails closed unless production supplies:

- trusted `wss://` public and worker endpoints;
- non-loopback production hosts;
- an advertised external IP plus RTC TCP and UDP ports;
- TURN/TLS on a hostname separate from signaling;
- HTTPS object storage and signed-webhook endpoint;
- bounded Egress output duration and recording retention;
- non-placeholder API, Redis, and S3 credentials.

Generated `livekit.yaml`, `egress.yaml`, `central-api.env`, and service-specific Compose environment files are written under an ignored runtime directory with restrictive permissions where the host supports them. Redis, MinIO, and the provisioning job each receive only the environment values they require. The command reports only non-secret deployment metadata and does not duplicate all smoke credentials into one file.

## Local Smoke Stack

`infra/media/compose.smoke.yaml` pins LiveKit, Egress, Redis, MinIO, and the MinIO client. LiveKit, Egress health/metrics, and MinIO ports bind to `127.0.0.1`. MinIO provisioning creates a private bucket, attaches the upload-only worker policy, and applies expiration to `recordings/`.

Room Composite Egress launches Chromium and transcodes media. The smoke worker therefore has the documented `SYS_ADMIN` capability and must remain isolated from application and database services. Production should use the maintained Egress seccomp/Helm guidance and dedicated capacity rather than extending this capability to unrelated containers.

## Verification Contract

Run the deterministic configuration gate on every change:

```powershell
npm run media-infra:check
```

It renders smoke and synthetic-production output and proves TLS/TURN requirements, shared Redis, bounded ports/duration, pinned images, private loopback exposure, secret redaction, lifecycle configuration, and least-privilege S3 actions.

Run the real deployment smoke only with a healthy Docker Linux engine or equivalent central environment:

```powershell
npm run media-infra:smoke
```

The smoke creates a fresh database and real call, obtains unanimous consent, starts and stops Room Composite Egress, verifies provider metadata and MP4 `ftyp` bytes, proves anonymous and worker-principal reads fail, checks the retention rule, deletes the object through the administrative test principal, removes the provider room, and tears down all smoke volumes. Missing infrastructure is a failure, not a skipped pass.

## Current Runtime Gate

On 2026-07-14, static configuration, type checking, and Compose parsing passed. The real MP4 smoke failed before startup because Docker Desktop 4.40.0 marked WSL as requiring an update and its elevated updater was denied, although `wsl --update` reported WSL 2.7.10.0 current. Docker Desktop 4.82.0 was available but installation required an elevated interactive step. No MP4 approval is claimed until `npm run media-infra:smoke` completes successfully after that host issue is resolved.

## Primary Sources

- [LiveKit deployment](https://docs.livekit.io/home/self-hosting/deployment/)
- [LiveKit ports and firewall](https://docs.livekit.io/home/self-hosting/ports-firewall/)
- [Self-hosting Egress](https://docs.livekit.io/home/self-hosting/egress/)
- [Egress outputs](https://docs.livekit.io/home/egress/outputs/)
- [LiveKit webhooks](https://docs.livekit.io/home/server/webhooks/)
- [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/)
- [Amazon S3 lifecycle management](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [Amazon S3 security best practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
