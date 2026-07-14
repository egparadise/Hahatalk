import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const allowDirty = args.includes("--allow-dirty");
const requireDesktop = args.includes("--require-desktop");
const outputIndex = args.indexOf("--output");
const outputPath = path.resolve(
  root,
  outputIndex >= 0 && args[outputIndex + 1]
    ? args[outputIndex + 1]
    : "apps/desktop/out/release-candidate-manifest.json"
);

function git(...gitArgs) {
  return execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

async function hashFile(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) return null;
  const content = await readFile(absolutePath);
  return {
    bytes: content.byteLength,
    path: relativePath.replaceAll("\\", "/"),
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

async function firstBundle(platform) {
  const directory = path.join(root, "apps", "mobile", "dist", platform, "_expo", "static", "js", platform);
  if (!existsSync(directory)) return null;
  const file = (await readdir(directory)).filter((name) => name.endsWith(".hbc")).sort()[0];
  return file ? hashFile(path.relative(root, path.join(directory, file))) : null;
}

const status = git("status", "--porcelain");
if (status && !allowDirty) {
  throw new Error("Release manifest requires a clean Git worktree. Use --allow-dirty only for local pre-commit verification.");
}

const desktopPackage = JSON.parse(await readFile(path.join(root, "apps", "desktop", "package.json"), "utf8"));
const mobilePackage = JSON.parse(await readFile(path.join(root, "apps", "mobile", "package.json"), "utf8"));
if (desktopPackage.version !== mobilePackage.version) {
  throw new Error("Desktop and mobile release versions must match.");
}

const artifactPaths = [
  "apps/desktop/out/make/squirrel.windows/x64/HahaTalkSetup.exe",
  `apps/desktop/out/make/squirrel.windows/x64/HahaTalk-${desktopPackage.version}-full.nupkg`,
  "apps/desktop/out/HahaTalk-win32-x64/HahaTalk.exe",
  "apps/desktop/out/HahaTalk-win32-x64/resources/app.asar",
  "apps/desktop/out/HahaTalk-win32-x64/resources/runtime/api.cjs",
  "apps/api/migrations/015_release_hardening.sql",
  "apps/api/migrations/016_release_hardening_lifecycle_concurrency.sql"
];
const artifacts = (await Promise.all(artifactPaths.map(hashFile))).filter(Boolean);
const androidBundle = await firstBundle("android");
const iosBundle = await firstBundle("ios");
if (androidBundle) artifacts.push(androidBundle);
if (iosBundle) artifacts.push(iosBundle);

if (requireDesktop) {
  const required = new Set(artifactPaths.slice(0, 5).map((value) => value.replaceAll("\\", "/")));
  const actual = new Set(artifacts.map((artifact) => artifact.path));
  const missing = [...required].filter((value) => !actual.has(value));
  if (missing.length) throw new Error(`Release desktop artifacts are missing: ${missing.join(", ")}`);
}

for (const artifact of artifacts) {
  const info = await stat(path.join(root, artifact.path));
  if (!info.isFile() || artifact.bytes <= 0) throw new Error(`Release artifact is empty: ${artifact.path}`);
}

const externalGates = [
  { detailCode: "legal_owner_approval_required", name: "legal_policy", status: "pending_external" },
  { detailCode: "docker_egress_mp4_required", name: "media_egress", status: "pending_external" },
  { detailCode: "apple_google_credentials_required", name: "mobile_signing", status: "pending_external" },
  { detailCode: "physical_android_ios_windows_required", name: "physical_devices", status: "pending_external" },
  { detailCode: "production_dns_tls_turn_monitoring_required", name: "production_infrastructure", status: "pending_external" },
  { detailCode: "inviz_authenticode_required", name: "windows_signing", status: "pending_external" }
];

const manifest = {
  artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)),
  build: {
    dirty: Boolean(status),
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    sourceCommit: git("rev-parse", "HEAD")
  },
  externalGates,
  format: "hahatalk-release-candidate-v1",
  requiredAutomatedGates: [
    "authorization",
    "backup_restore",
    "contracts",
    "dependency_audit",
    "full_harness",
    "load_reconnect",
    "schema",
    "windows_install"
  ],
  source: {
    repository: "https://github.com/egparadise/Hahatalk.git",
    schemaVersion: "016_release_hardening_lifecycle_concurrency.sql"
  },
  version: desktopPackage.version
};

await mkdir(path.dirname(outputPath), { recursive: true });
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(outputPath, serialized, "utf8");
const digest = createHash("sha256").update(serialized).digest("hex");
await writeFile(`${outputPath}.sha256`, `${digest}  ${path.basename(outputPath)}\n`, "ascii");
console.log(`Release manifest ${path.relative(root, outputPath)} SHA-256 ${digest}`);
