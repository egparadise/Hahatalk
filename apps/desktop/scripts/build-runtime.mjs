import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const runtimeRoot = path.join(desktopRoot, "runtime");
const webRuntimeRoot = path.join(runtimeRoot, "web");
const runtimeNodeModulesRoot = path.join(runtimeRoot, "node_modules");
const postgresRuntimeRoot = path.join(runtimeRoot, "postgres");
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
  external: ["@nestjs/microservices", "@nestjs/microservices/*", "argon2"],
  format: "cjs",
  logLevel: "warning",
  outfile: bundledApi,
  platform: "node",
  sourcemap: false,
  target: "node22"
});

await cp(path.join(repoRoot, "apps", "web", "out"), webRuntimeRoot, { recursive: true });
await cp(path.join(repoRoot, "apps", "api", "migrations"), path.join(runtimeRoot, "migrations"), { recursive: true });
await cp(path.join(repoRoot, "node_modules", "argon2"), path.join(runtimeNodeModulesRoot, "argon2"), { recursive: true });
await cp(
  path.join(repoRoot, "node_modules", "@phc", "format"),
  path.join(runtimeNodeModulesRoot, "@phc", "format"),
  { recursive: true }
);
await cp(
  path.join(repoRoot, "node_modules", "node-gyp-build"),
  path.join(runtimeNodeModulesRoot, "node-gyp-build"),
  { recursive: true }
);

const postgresSourceRoot = process.env.HAHATALK_POSTGRES_ROOT
  ?? path.join(process.env.LOCALAPPDATA ?? "", "HahaTalkDev", "PostgreSQL", "18.4", "pgsql");
for (const directory of ["bin", "lib", "share"]) {
  const source = path.join(postgresSourceRoot, directory);
  await access(source);
  await cp(source, path.join(postgresRuntimeRoot, directory), { recursive: true });
}
for (const licenseName of ["server_license.txt", "commandlinetools_3rd_party_licenses.txt"]) {
  const source = path.join(postgresSourceRoot, licenseName);
  await access(source);
  await cp(source, path.join(postgresRuntimeRoot, licenseName));
}

const indexPath = path.join(webRuntimeRoot, "index.html");
const migrationRoot = path.join(runtimeRoot, "migrations");
const migrationNames = (await readdir(migrationRoot))
  .filter((fileName) => /^\d+_[a-z0-9_-]+\.sql$/i.test(fileName))
  .sort((left, right) => left.localeCompare(right));
const migrationSha256 = Object.fromEntries(await Promise.all(
  migrationNames.map(async (fileName) => [fileName, await sha256(path.join(migrationRoot, fileName))])
));
const manifest = {
  apiSha256: await sha256(bundledApi),
  generatedAt: new Date().toISOString(),
  indexSha256: await sha256(indexPath),
  migrationSha256,
  postgres: {
    initdbSha256: await sha256(path.join(postgresRuntimeRoot, "bin", "initdb.exe")),
    pgCtlSha256: await sha256(path.join(postgresRuntimeRoot, "bin", "pg_ctl.exe")),
    version: "18.4"
  },
  runtimeVersion: 6
};
await writeFile(path.join(runtimeRoot, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`HahaTalk desktop runtime built at ${runtimeRoot}`);
