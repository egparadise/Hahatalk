import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const output = path.join(root, "node_modules", ".cache", "hahatalk-release-manifest-check.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const outputChunks = [];
    child.stdout.on("data", (chunk) => outputChunks.push(String(chunk)));
    child.stderr.on("data", (chunk) => outputChunks.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(outputChunks.join(""))));
  });
}

await run(process.execPath, ["tools/release/create-release-manifest.mjs", "--allow-dirty", "--output", path.relative(root, output)]);
const serialized = await readFile(output, "utf8");
const manifest = JSON.parse(serialized);
assert(manifest.format === "hahatalk-release-candidate-v1", "Release manifest format is invalid.");
assert(manifest.source?.schemaVersion === "016_release_hardening_lifecycle_concurrency.sql", "Release manifest schema version is stale.");
assert(Array.isArray(manifest.artifacts) && manifest.artifacts.some((item) => item.path === "apps/api/migrations/015_release_hardening.sql"), "Hardening migration artifact hash is missing.");
assert(manifest.artifacts.some((item) => item.path === "apps/api/migrations/016_release_hardening_lifecycle_concurrency.sql"), "Lifecycle concurrency migration artifact hash is missing.");
assert(manifest.externalGates.length === 6 && manifest.externalGates.every((gate) => gate.status === "pending_external"), "External gates must remain explicit and pending.");
assert(manifest.requiredAutomatedGates.length === 8, "Automated release gates are incomplete.");
for (const artifact of manifest.artifacts) {
  assert(!path.isAbsolute(artifact.path) && !artifact.path.includes(".."), `Artifact path is unsafe: ${artifact.path}`);
  assert(/^[a-f0-9]{64}$/.test(artifact.sha256) && artifact.bytes > 0, `Artifact digest is invalid: ${artifact.path}`);
}
assert(!/[A-Z]:\\|BEGIN [A-Z ]*PRIVATE KEY|password|hht_[a-z0-9_-]{16,}/i.test(serialized), "Release manifest contains an absolute path or secret-like value.");
const sidecar = (await readFile(`${output}.sha256`, "ascii")).trim().split(/\s+/, 1)[0];
assert(sidecar === createHash("sha256").update(serialized).digest("hex"), "Release manifest sidecar digest does not match.");
await rm(output, { force: true });
await rm(`${output}.sha256`, { force: true });
assert(!existsSync(output), "Release manifest test artifact was not cleaned.");
console.log("Release artifact check passed: relative paths, hashes, schema identity, automated gates, pending external gates, and secret redaction are valid.");
