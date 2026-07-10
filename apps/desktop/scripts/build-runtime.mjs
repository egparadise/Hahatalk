import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const runtimeRoot = path.join(desktopRoot, "runtime");
const webRuntimeRoot = path.join(runtimeRoot, "web");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function runNpm(args) {
  const result = spawnSync(npmCommand, args, {
    cwd: repoRoot,
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

async function sha256(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

await rm(runtimeRoot, { force: true, recursive: true });
await mkdir(runtimeRoot, { recursive: true });

runNpm(["run", "build", "-w", "apps/api"]);
runNpm(["run", "build", "-w", "apps/web"]);

const apiEntry = path.join(repoRoot, "apps", "api", "dist", "main.js");
const bundledApi = path.join(runtimeRoot, "api.cjs");
await build({
  bundle: true,
  entryPoints: [apiEntry],
  external: ["@nestjs/microservices", "@nestjs/microservices/*"],
  format: "cjs",
  logLevel: "warning",
  outfile: bundledApi,
  platform: "node",
  sourcemap: false,
  target: "node22"
});

await cp(path.join(repoRoot, "apps", "web", "out"), webRuntimeRoot, { recursive: true });

const indexPath = path.join(webRuntimeRoot, "index.html");
const manifest = {
  apiSha256: await sha256(bundledApi),
  generatedAt: new Date().toISOString(),
  indexSha256: await sha256(indexPath),
  runtimeVersion: 1
};
await writeFile(path.join(runtimeRoot, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`HahaTalk desktop runtime built at ${runtimeRoot}`);
