import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "apps/web/app/page.tsx",
  "apps/web/components/work-desk.tsx",
  "apps/api/src/main.ts",
  "apps/api/src/modules/chat.controller.ts",
  "apps/api/src/modules/demo-store.ts",
  "apps/api/src/modules/chat.gateway.ts",
  "apps/desktop/main.cjs",
  "packages/contracts/src/index.ts",
  "docs/mvp-architecture.md",
  "docs/schema.sql",
  "AGENTS.md",
  ".agents/skills/hahatalk-feature-stage/SKILL.md",
  ".codex/hooks.json"
];
const requiredTerms = [
  "hub",
  "audienceType",
  "message_audiences",
  "message_deliveries",
  "hub_announcement",
  "projectMessageForViewer",
  "spaces/:spaceId/view",
  "auth/signup",
  "auth/login",
  "AuthSession",
  "MvpSnapshot",
  "POST /messages",
  "POST /invites",
  "POST /attachments",
  "messages/:messageId/confirm",
  "confirmMessageRead",
  "CreateAttachmentMessageInput",
  "AI 작업",
  "화면 캡처"
];

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) {
    throw new Error(`Missing required file: ${file}`);
  }
}

const source = [
  readFileSync(join(root, "apps/web/components/work-desk.tsx"), "utf8"),
  readFileSync(join(root, "apps/api/src/modules/chat.controller.ts"), "utf8"),
  readFileSync(join(root, "apps/api/src/modules/demo-store.ts"), "utf8"),
  readFileSync(join(root, "apps/api/src/modules/chat.gateway.ts"), "utf8"),
  readFileSync(join(root, "packages/contracts/src/index.ts"), "utf8"),
  readFileSync(join(root, "docs/mvp-architecture.md"), "utf8"),
  readFileSync(join(root, "docs/schema.sql"), "utf8"),
  readFileSync(join(root, "AGENTS.md"), "utf8")
].join("\n");

for (const term of requiredTerms) {
  if (!source.includes(term)) {
    throw new Error(`Smoke term not found: ${term}`);
  }
}

console.log("Smoke check passed: HahaTalk hub privacy, API, governance, and media terms are present.");
