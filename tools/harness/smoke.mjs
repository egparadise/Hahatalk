import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "apps/web/app/page.tsx",
  "apps/web/components/work-desk.tsx",
  "apps/api/src/main.ts",
  "apps/api/src/modules/chat.controller.ts",
  "apps/api/src/modules/demo-store.ts",
  "apps/desktop/main.cjs",
  "packages/contracts/src/index.ts",
  "docs/mvp-architecture.md"
];
const requiredTerms = [
  "Smart Room",
  "audienceType",
  "message_audiences",
  "message_reads",
  "auth/signup",
  "auth/login",
  "AuthSession",
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
  readFileSync(join(root, "packages/contracts/src/index.ts"), "utf8"),
  readFileSync(join(root, "docs/mvp-architecture.md"), "utf8"),
  readFileSync(join(root, "docs/schema.sql"), "utf8")
].join("\n");

for (const term of requiredTerms) {
  if (!source.includes(term)) {
    throw new Error(`Smoke term not found: ${term}`);
  }
}

console.log("Smoke check passed: HahaTalk MVP files and Smart Room terms are present.");
