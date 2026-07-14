import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputIndex = process.argv.indexOf("--output");
const outputPath = path.resolve(
  root,
  outputIndex >= 0 && process.argv[outputIndex + 1]
    ? process.argv[outputIndex + 1]
    : "apps/desktop/out/hahatalk-sbom.cyclonedx.json"
);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required. Run this script through npm run release:sbom.");

const content = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [npmCli, "sbom", "--omit=dev", "--sbom-format=cyclonedx"], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  child.once("error", reject);
  child.once("exit", (code) => {
    if (code !== 0) reject(new Error(`npm sbom exited ${code}.\n${stderr.join("")}`));
    else resolve(Buffer.concat(stdout).toString("utf8"));
  });
});

const sbom = JSON.parse(content);
if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
  throw new Error("npm returned an invalid CycloneDX SBOM.");
}
const serialized = `${JSON.stringify(sbom, null, 2)}\n`;
if (/[A-Z]:\\|BEGIN [A-Z ]*PRIVATE KEY|hht_[a-z0-9_-]{16,}/i.test(serialized)) {
  throw new Error("SBOM contains a local absolute path or secret-like value.");
}
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized, "utf8");
console.log(`CycloneDX SBOM written to ${path.relative(root, outputPath)} with ${sbom.components.length} components.`);
