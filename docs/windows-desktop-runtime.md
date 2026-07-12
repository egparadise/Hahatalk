# HahaTalk Windows Desktop Runtime

## Goal

HahaTalk must start from an installed Windows executable without requiring Node.js, npm, the source repository, or separately started web/API/database development servers. The PC-first development package includes PostgreSQL 18.4 server binaries and manages a per-user local database. A later multi-device release will use the managed HahaTalk backend instead of a database on every client.

## Runtime Layout

```text
HahaTalk.exe
 -> Electron main process
 -> embedded PostgreSQL on an ephemeral loopback port
 -> loopback static server on an ephemeral port
 -> NestJS API bundle in Electron utilityProcess on another ephemeral port
 -> sandboxed renderer with context-isolated preload bridge
```

The Next.js client is exported as static HTML/CSS/JavaScript. The compiled NestJS API is bundled from TypeScript output so decorator metadata remains intact. Generated assets, immutable SQL migrations, PostgreSQL `bin/lib/share`, and the Windows Argon2 native runtime are copied to `resources/runtime` outside `app.asar`; source code, pgAdmin, headers, and unrelated development dependencies are not copied. User file bytes are stored separately under `%APPDATA%/HahaTalk/objects`, never in the install directory or static web root.

## Startup Sequence

1. Handle Squirrel install, update, uninstall, or obsolete events.
2. Acquire the single-instance lock.
3. Initialize the per-user PostgreSQL data directory and random local password on first run.
4. Start embedded PostgreSQL on an operating-system-assigned loopback port and create the `hahatalk` database if needed.
5. Start the static server on `127.0.0.1` with another operating-system-assigned port.
6. Start the API in `utilityProcess` with a separate available loopback port and a generated database URL.
7. Apply checksum-verified PostgreSQL migrations, then poll `/health`; retry API startup once on failure.
8. Pass the resolved API URL to the renderer through `additionalArguments` and `contextBridge`.
9. Write `%APPDATA%/HahaTalk/runtime-status.json` as runtime verification evidence without database credentials.
10. Verify from the renderer that the preload-provided API URL answers `/health`, then create the window.

## Security Boundary

- `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true` remain mandatory.
- Navigation is compared by parsed URL origin; unknown HTTP(S) or mail links open in the system browser.
- The local static server binds only to `127.0.0.1` and prevents path traversal.
- Static responses include CSP, `nosniff`, no-referrer, and frame-deny headers.
- CSP permits image/audio/video bytes only from the loopback API origin; `.mjs` is served as JavaScript for the same-origin PDF.js worker.
- Camera, microphone, fullscreen, and display capture permissions are limited to runtime origins.
- Screen capture requires a user gesture and a local source-selection dialog.
- The API is isolated from the renderer in Electron `utilityProcess`.
- The renderer receives only an opaque HttpOnly cookie; authentication responses and preload APIs never expose the session token.
- The embedded database binds only to loopback, uses a random SCRAM password, stores credentials with the per-user runtime state, and stops after the API during clean shutdown.

## Build Commands

```powershell
npm run desktop:runtime
npm run desktop:check -- --require-runtime
npm run desktop:package
npm run desktop:make
npm run desktop:smoke
```

Outputs:

```text
apps/desktop/out/HahaTalk-win32-x64/HahaTalk.exe
apps/desktop/out/make/squirrel.windows/x64/HahaTalkSetup.exe
```

## Verification Gate

- packaged executable starts with ports 3000 and 4000 closed
- status file reports `packaged: true`
- status file reports `rendererReady: true` and `rendererApiHealthy: true`
- API `/health` proves embedded PostgreSQL connectivity without port 54329 or another external database process
- authenticated owner projection returns four demo users and authenticated participant projection returns only two even with a forged `viewerId`
- second executable invocation exits and leaves one main window
- normal window close removes the status file and closes the API and embedded database ports
- installed executable runs from `%LOCALAPPDATA%/HahaTalk/app-<version>`
- installed renderer uploads and previews an authenticated image, stores and renders a private PDF, opens it in a separate window, and writes originals/derivatives only under the private object root
- renderer E2E sets `HAHATALK_USER_DATA_DIR` to a unique OS temporary profile, claims the seed owner there, and removes that profile after clean shutdown so automated accounts/media never enter the user's normal database
- production dependency audit reports zero vulnerabilities

## Release Limitations

- The current installer is unsigned. Windows code signing is required before external distribution to avoid trust warnings and to support a production update channel.
- Accounts, sessions, invitations, consent evidence, conversations, deliveries, read state, idempotency, outbox events, and media metadata persist in embedded PostgreSQL. Binary media persists in the private per-user object root.
- Runtime manifest version 5 records every immutable SQL migration and SHA-256 fingerprints for `pg_ctl.exe` and `initdb.exe`.
- Managed S3 and production ClamAV remain deployment boundaries; the packaged local provider and bounded standalone scanner are the verified PC baseline.
- The embedded database is a PC-first single-device topology. Multi-device sync and horizontal scaling require the managed server deployment.
- The installer currently targets Windows x64. ARM64 is a later build target.
- Screen capture uses a name-based local selector; thumbnail selection and per-window consent history can be improved later.

## Primary Sources

- [Electron packaging tutorial](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron display media session API](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)
- [Electron Forge Squirrel.Windows](https://www.electronforge.io/config/makers/squirrel.windows)
- [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports)
