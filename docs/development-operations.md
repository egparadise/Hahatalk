# HahaTalk Development Operations

## Canonical Paths

- Program and source code root: `C:\Project\Hahattalk`
- Obsidian planning and report root: `C:\Users\egpar\OneDrive - Inviz\15.Vibe Cording\Obsidian\hahtalk\HahaTalk`
- GitHub remote for the program repository: `https://github.com/egparadise/Hahatalk.git`

The code repository and Obsidian vault stay separate. Application code, tests, harnesses, package files, database schema, and build scripts live in the program root. Product planning, decision logs, development reports, test notes, and error/fix records live in the Obsidian root.

## Development Loop

Every meaningful feature session follows this order:

1. Read the latest Obsidian plan and report.
2. Check `git status` in `C:\Project\Hahattalk`.
3. Create an Obsidian report in `90_Reports` using `YYYY-MM-DD_HH-mm_<feature>.md`.
4. Implement a small vertical slice.
5. Run the app or the closest harness.
6. Fix failures and rerun until clean.
7. Update the Obsidian report with commands, errors, fixes, and results.
8. Run the final harness.
9. Commit from `C:\Project\Hahattalk`.
10. Push to `https://github.com/egparadise/Hahatalk.git`.
11. Record branch, commit hash, and push result in the Obsidian report.

## Standard Commands

Create a report only:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\harness\new-obsidian-report.ps1 -Feature "feature-name" -Goal "short goal"
```

Run the full local verification harness:

```powershell
npm run harness
```

Run the managed development loop after a feature is ready:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\harness\development-loop.ps1 -Feature "feature-name" -Mode pre-commit -Commit -Push -CommitMessage "Implement feature name"
```

## Git Rules

- Git root is always `C:\Project\Hahattalk`.
- `origin` must point to `https://github.com/egparadise/Hahatalk.git`.
- Commit only after the harness passes.
- Do not commit secrets, local `.env` files, uploaded files, model weights, recordings, generated media, or cache directories.
- Obsidian reports are local development records unless a separate documentation sync is intentionally planned.

## Verification Rules

The current MVP harness runs:

- TypeScript typecheck
- Contract tests
- Production build
- Smoke test

For UI or desktop changes, also run the app and record the observed result in the Obsidian report.

For central media infrastructure changes, always run `npm run media-infra:check`. Run `npm run media-infra:smoke` when a Docker Linux engine or production-equivalent Egress environment is available. The real-media command is intentionally strict: an unavailable engine, missing worker, failed MP4, public object, incorrect retention rule, or failed cleanup is a failed deployment gate and must not be converted into a skip-success result.
