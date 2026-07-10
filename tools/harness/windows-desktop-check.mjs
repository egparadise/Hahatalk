import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const requireRuntime = process.argv.includes("--require-runtime");

const requiredFiles = [
  "apps/desktop/forge.config.cjs",
  "apps/desktop/main.cjs",
  "apps/desktop/preload.cjs",
  "apps/desktop/scripts/build-runtime.mjs",
  "apps/desktop/scripts/generate-windows-icon.ps1",
  "tools/harness/windows-package-smoke.ps1"
];

for (const relativePath of requiredFiles) {
  await access(path.join(repoRoot, relativePath));
}

const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const nextConfig = await readFile(path.join(repoRoot, "apps", "web", "next.config.mjs"), "utf8");
const mainSource = await readFile(path.join(desktopRoot, "main.cjs"), "utf8");
const preloadSource = await readFile(path.join(desktopRoot, "preload.cjs"), "utf8");

const assertions = [
  [desktopPackage.productName === "HahaTalk", "desktop productName must be HahaTalk"],
  [Boolean(desktopPackage.scripts?.make), "desktop make script is required"],
  [Boolean(desktopPackage.devDependencies?.["@electron-forge/cli"]), "Electron Forge CLI is required"],
  [Boolean(desktopPackage.devDependencies?.["@electron-forge/maker-squirrel"]), "Squirrel.Windows maker is required"],
  [nextConfig.includes('output: "export"'), "Next.js static export is required for packaged runtime"],
  [mainSource.includes("requestSingleInstanceLock"), "single-instance protection is required"],
  [mainSource.includes("getPrimaryDisplay().workAreaSize"), "window size must respect the Windows work area"],
  [mainSource.includes("utilityProcess.fork"), "packaged API must run in a utility process"],
  [mainSource.includes("setDisplayMediaRequestHandler"), "desktop screen-capture selection handler is required"],
  [mainSource.includes("will-navigate"), "navigation restriction is required"],
  [mainSource.includes("runtime-status.json"), "packaged runtime status evidence is required"],
  [mainSource.includes("rendererApiHealthy"), "renderer-to-API bridge verification is required"],
  [preloadSource.includes("hahatalk-api-url"), "preload must expose the runtime API URL"],
  [preloadSource.includes("contextBridge"), "preload must use contextBridge"]
];

for (const [passed, message] of assertions) {
  if (!passed) throw new Error(message);
}

if (requireRuntime) {
  const runtimeFiles = [
    path.join(desktopRoot, "runtime", "api.cjs"),
    path.join(desktopRoot, "runtime", "runtime-manifest.json"),
    path.join(desktopRoot, "runtime", "web", "index.html")
  ];
  for (const filePath of runtimeFiles) await access(filePath);
}

console.log(`Windows desktop check passed${requireRuntime ? " with packaged runtime assets" : ""}.`);
