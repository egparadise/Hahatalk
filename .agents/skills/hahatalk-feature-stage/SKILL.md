---
name: hahatalk-feature-stage
description: Run one complete HahaTalk architecture, schema, feature, bug-fix, AI/media, security, test, build, commit, or push stage. Use when work in C:\Project\Hahattalk must follow the project's research-first, privacy-first, Obsidian-reporting, verification-loop, and Git publication rules.
---

# HahaTalk Feature Stage

Keep each run to one reviewable vertical slice while preserving the full product architecture.

## Start

1. Read `AGENTS.md`.
2. Read the relevant Obsidian product, architecture, schema, engineering, quality, and latest report files.
3. Run `git status -sb` in `C:\Project\Hahattalk` and preserve unrelated changes.
4. Create a timestamped report with `npm run report:new -- -Feature "<feature>" -Goal "<goal>"`.

## Research Gate

Before implementation, search current primary sources for the stage's frameworks, models, protocols, security requirements, platform limits, and licenses. Prefer official documentation, official repositories, standards, and original model cards. Record:

- access date and direct URL
- claim supported by the source
- selected option and why
- rejected alternatives and license or operational risk

Never treat a remembered version, model name, mobile capability, or license as current without verification.

## Design Gate

Define the user flow and then verify:

- authenticated actor and membership
- owner, admin, member, guest, and subscriber behavior
- hub owner projection versus participant direct-chat projection
- sender intent versus resolved deliveries
- consent, expiry, revoke, and audit requirements
- loading, empty, error, retry, cancellation, and idempotency behavior
- asynchronous boundaries for AI and media

Read `references/stage-gates.md` for the stage-specific exit gate.

## Implement And Loop

1. Update contracts and schema first when behavior changes.
2. Implement the smallest end-to-end path.
3. Add tests for success, denial, and privacy leakage.
4. Run the narrow check, fix failures, and rerun.
5. Run `npm run harness` before completion.
6. Run the web/API or desktop app and inspect the changed flow.

Do not broadcast a hub message to a shared socket room. Emit a viewer-safe projection to each recipient's authenticated user channel.

## Record And Publish

Update the Obsidian report with files, commands, failures, fixes, decisions, risks, and execution evidence. Add the user prompt and concise decision rationale to the prompt log. Add or update a learning page when the stage introduces a new concept.

Commit only the intended files after verification, push the `codex/<feature>` branch, and record the commit hash and push result. Ask the user to approve the running stage; do not label the whole product complete while later stages remain.
