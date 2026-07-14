# HahaTalk Central Media Infrastructure

This directory defines the Stage 6F boundary between end-user HahaTalk clients and central media services. It never contains live credentials, certificates, recording objects, or generated runtime configuration.

## What Is Reproducible Here

- Structured deployment manifests validated before rendering.
- LiveKit `1.13.3`, Egress `1.12.0`, Redis `8.8.0`, MinIO, and `mc` pinned by tag and registry manifest digest for the local deployment smoke.
- One shared Redis instance used by LiveKit and Egress.
- A private S3-compatible recording bucket with an upload-only Egress principal and prefix lifecycle expiration.
- Generated LiveKit, Egress, central API, service-isolated Compose environment, and least-privilege policy files under ignored `runtime/`.
- An optional real Room Composite MP4 smoke that fails when Docker/Egress/storage is not genuinely available.

The smoke stack binds management and object-storage ports to loopback. It is not an internet deployment and must never be presented as trusted `wss` or TURN/TLS.

## Prepare A Local Smoke

```powershell
npm run media-infra:prepare
npm run media-infra:check
npm run media-infra:smoke
```

`media-infra:prepare` generates random test credentials into `infra/media/runtime`. `media-infra:smoke` starts the pinned Linux containers, creates a fresh PostgreSQL database, records a short Room Composite MP4, verifies the private object and retention rule, removes the object, and tears down the smoke volumes.

## Production Rendering

1. Copy `deployment.production.example.json` outside the repository and replace every `.invalid` endpoint.
2. Supply these values through the deployment platform's secret manager, not a committed file:
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
   - `REDIS_PASSWORD`
   - `LIVEKIT_EGRESS_S3_ACCESS_KEY`
   - `LIVEKIT_EGRESS_S3_SECRET_KEY`
3. Render into an operator-controlled temporary directory:

```powershell
node tools/infra/render-media-deployment.mjs --manifest C:\secure\hahatalk-media.json --output C:\secure\hahatalk-media-runtime
```

The generated `central-api.env`, `livekit.yaml`, and `egress.yaml` contain credentials. Mount or inject them with restrictive permissions and remove them from the deployment workstation after the platform accepts the secrets.

## Production Gate

Production is not approved until all of the following are independently proven:

- A trusted CA certificate serves `wss://` on the LiveKit domain. Self-signed certificates do not satisfy the gate.
- A separate TURN domain and certificate work through a restrictive-network test. TURN/TLS is exposed on `443` when no layer-4 load balancer is used.
- RTC TCP `7881` and the configured UDP range are open directly to the LiveKit node. Signal port `7880`, Redis, Egress health, MinIO management, and object APIs are not publicly exposed without an authenticated proxy boundary.
- Egress has at least 4 CPU and 4 GB RAM per worker, shares the exact LiveKit Redis database, and exposes health/Prometheus only to monitoring.
- The bucket denies anonymous access, Egress cannot list, read, or delete objects, lifecycle expiration matches the recorded organization policy, and the API uses a separate read/delete principal when playback is implemented.
- Webhooks terminate at the dedicated signed endpoint and preserve the raw `application/webhook+json` body.
- Provider/API credentials are injected only into central services. They are absent from Electron resources, renderer globals, status files, logs, and Git history.
- DNS, certificates, firewall rules, secret-manager references, backup/restore, monitoring, and rollback are documented for the chosen cloud or data center.

## Capacity And Security Notes

Room Composite recording launches Chrome and transcodes media. The smoke Compose grants Egress `SYS_ADMIN` because current LiveKit self-hosting guidance requires it for Room Composite Chrome startup. Production should isolate Egress workers and use the maintained seccomp profile or the LiveKit Helm deployment instead of broadening unrelated service privileges.
