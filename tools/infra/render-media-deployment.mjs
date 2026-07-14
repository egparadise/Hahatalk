import path from "node:path";
import {
  deploymentSecretsFromEnvironment,
  generateSmokeSecrets,
  readDeploymentManifest,
  renderMediaDeployment
} from "./media-deployment-lib.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const root = process.cwd();
const manifestPath = path.resolve(argument("manifest") ?? path.join(root, "infra", "media", "deployment.smoke.json"));
const outputDirectory = path.resolve(argument("output") ?? path.join(root, "infra", "media", "runtime"));
const manifest = await readDeploymentManifest(manifestPath);
const generate = process.argv.includes("--generate-smoke-secrets");
if (generate && manifest.environment !== "smoke") {
  throw new Error("Generated credentials are allowed only for the local smoke manifest.");
}
const secrets = generate ? generateSmokeSecrets() : deploymentSecretsFromEnvironment();
const result = await renderMediaDeployment({ manifest, outputDirectory, secrets });

console.log(JSON.stringify({
  environment: result.summary.environment,
  livekitUrl: result.summary.livekit.publicUrl,
  outputDirectory,
  secretValuesPrinted: false,
  storageBucket: result.summary.storage.bucket
}, null, 2));
