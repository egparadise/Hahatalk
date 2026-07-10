# HahaTalk Windows Desktop Runtime

## Goal

HahaTalk must start from an installed Windows executable without requiring Node.js, npm, the source repository, or separately started web/API development servers. The Stage 2 development package requires a reachable PostgreSQL service; production distribution will point the desktop client at the managed HahaTalk backend rather than installing a database on every user PC.

## Runtime Layout

```text
HahaTalk.exe
 -> Electron main process
 -> loopback static server on an ephemeral port
 -> NestJS API bundle in Electron utilityProcess on another ephemeral port
 -> sandboxed renderer with context-isolated preload bridge
```

The Next.js client is exported as static HTML/CSS/JavaScript. The compiled NestJS API is bundled from TypeScript output so decorator metadata remains intact. Generated assets, immutable SQL migrations, and the Windows Argon2 native runtime are copied to `resources/runtime` outside `app.asar`; source code and unrelated development dependencies are not copied.

## Startup Sequence

1. Handle Squirrel install, update, uninstall, or obsolete events.
2. Acquire the single-instance lock.
3. Start the static server on `127.0.0.1` with an operating-system-assigned port.
4. Start the API in `utilityProcess` with a separate available loopback port.
5. Apply checksum-verified PostgreSQL migrations, then poll `/health`; retry API startup once on failure.
6. Pass the resolved API URL to the renderer through `additionalArguments` and `contextBridge`.
7. Write `%APPDATA%/HahaTalk/runtime-status.json` as runtime verification evidence.
8. Verify from the renderer that the preload-provided API URL answers `/health`.
9. Create a window sized to the current Windows work area.

## Security Boundary

- `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true` remain mandatory.
- Navigation is compared by parsed URL origin; unknown HTTP(S) or mail links open in the system browser.
- The local static server binds only to `127.0.0.1` and prevents path traversal.
- Static responses include CSP, `nosniff`, no-referrer, and frame-deny headers.
- Camera, microphone, fullscreen, and display capture permissions are limited to runtime origins.
- Screen capture requires a user gesture and a local source-selection dialog.
- The API is isolated from the renderer in Electron `utilityProcess`.
- The renderer receives only an opaque HttpOnly cookie; authentication responses and preload APIs never expose the session token.

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
- API `/health` proves PostgreSQL connectivity
- authenticated owner projection returns four demo users and authenticated participant projection returns only two even with a forged `viewerId`
- second executable invocation exits and leaves one main window
- normal window close removes the status file and closes the API port
- installed executable runs from `%LOCALAPPDATA%/HahaTalk/app-<version>`
- production dependency audit reports zero vulnerabilities

## Release Limitations

- The current installer is unsigned. Windows code signing is required before external distribution to avoid trust warnings and to support a production update channel.
- Accounts, Argon2id password hashes, sessions, invitations, approval requirements/decisions, consent evidence, and auth audit events persist in PostgreSQL. Conversation and attachment mutations remain in-memory until Stage 3.
- Runtime manifest version 3 records a SHA-256 entry for every immutable SQL migration, including Stage 2B migration `002`.
- The Stage 2 development installer needs local PostgreSQL on port 54329. This is a development topology, not the production end-user architecture.
- The installer currently targets Windows x64. ARM64 is a later build target.
- Screen capture uses a name-based local selector; thumbnail selection and per-window consent history can be improved later.

## Primary Sources

- [Electron packaging tutorial](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron display media session API](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)
- [Electron Forge Squirrel.Windows](https://www.electronforge.io/config/makers/squirrel.windows)
- [Next.js static exports](https://nextjs.org/docs/app/guides/static-exports)
