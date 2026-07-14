import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  generateSmokeSecrets,
  readDeploymentManifest,
  renderMediaDeployment,
  validateMediaDeployment
} from "../infra/media-deployment-lib.mjs";

const root = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectInvalid(manifest, secrets, pattern) {
  let message = "";
  try {
    validateMediaDeployment(manifest, secrets);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(pattern.test(message), `Expected deployment validation failure ${pattern}, received: ${message || "no error"}`);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hahatalk-media-config-"));
try {
  const smokeManifest = await readDeploymentManifest(path.join(root, "infra", "media", "deployment.smoke.json"));
  const smokeSecrets = generateSmokeSecrets();
  const smokeOutput = path.join(tempRoot, "smoke");
  await renderMediaDeployment({ manifest: smokeManifest, outputDirectory: smokeOutput, secrets: smokeSecrets });

  const livekit = parseYaml(await readFile(path.join(smokeOutput, "livekit.yaml"), "utf8"));
  const egress = parseYaml(await readFile(path.join(smokeOutput, "egress.yaml"), "utf8"));
  const policy = JSON.parse(await readFile(path.join(smokeOutput, "egress-write-policy.json"), "utf8"));
  const summaryText = await readFile(path.join(smokeOutput, "deployment-summary.json"), "utf8");
  const centralApiEnvironment = await readFile(path.join(smokeOutput, "central-api.env"), "utf8");
  const redisEnvironment = await readFile(path.join(smokeOutput, "redis.env"), "utf8");
  const minioEnvironment = await readFile(path.join(smokeOutput, "minio.env"), "utf8");
  const provisionEnvironment = await readFile(path.join(smokeOutput, "provision.env"), "utf8");

  assert(livekit.redis.address === "redis:6379" && livekit.redis.password === smokeSecrets.REDIS_PASSWORD, "LiveKit did not render the shared authenticated Redis connection.");
  assert(livekit.rtc.node_ip === undefined && livekit.rtc.use_external_ip === false && livekit.rtc.udp_port === 7882, "Smoke LiveKit did not render a Compose-internal ICE address with deterministic RTC ports.");
  assert(livekit.keys[smokeSecrets.LIVEKIT_API_KEY] === smokeSecrets.LIVEKIT_API_SECRET, "LiveKit API credentials were not rendered structurally.");
  assert(egress.redis.address === livekit.redis.address && egress.redis.password === livekit.redis.password, "Egress and LiveKit do not share the exact Redis database.");
  assert(egress.ws_url === "ws://livekit:7880" && egress.insecure === true, "Smoke Egress worker URL was not explicitly marked local/insecure.");
  assert(egress.health_port === 8080 && egress.prometheus_port === 8081, "Egress health and metrics ports are missing.");
  assert(egress.session_limits.file_output_max_duration === "15m", "Egress file duration is not bounded.");
  assert(centralApiEnvironment.includes("HAHATALK_TEST_MEDIA_INFRA=1"), "Smoke central API did not receive the test-only private-network boundary.");
  assert(redisEnvironment.trim() === `REDIS_PASSWORD=${smokeSecrets.REDIS_PASSWORD}`, "Redis received credentials outside its own trust boundary.");
  assert(minioEnvironment.includes(`MINIO_ROOT_USER=${smokeSecrets.MINIO_ROOT_USER}`) && !minioEnvironment.includes("REDIS_PASSWORD") && !minioEnvironment.includes("LIVEKIT_"), "MinIO received credentials outside its own trust boundary.");
  assert(provisionEnvironment.includes(`RECORDING_RETENTION_DAYS=${smokeManifest.storage.retentionDays}`) && !provisionEnvironment.includes("REDIS_PASSWORD") && !provisionEnvironment.includes("LIVEKIT_API_"), "Provisioning environment is missing retention or received credentials outside its trust boundary.");
  assert(!(await readdir(smokeOutput)).includes("smoke-credentials.json"), "Renderer duplicated all smoke credentials into one unnecessary file.");

  const policyActions = policy.Statement.flatMap((statement) => statement.Action);
  assert(policyActions.includes("s3:PutObject") && policyActions.includes("s3:AbortMultipartUpload"), "Egress policy cannot upload a recording.");
  assert(!policyActions.includes("s3:GetObject") && !policyActions.includes("s3:DeleteObject") && !policyActions.includes("s3:ListBucket") && !policyActions.includes("s3:ListBucketMultipartUploads") && !policyActions.includes("s3:*"), "Egress policy grants read, delete, list, or wildcard access.");
  assert(policy.Statement.every((statement) => statement.Resource.every((resource) => resource.includes(smokeManifest.storage.bucket))), "Egress policy escaped the recording bucket.");
  for (const secret of Object.values(smokeSecrets)) {
    assert(!summaryText.includes(secret), "Redacted deployment summary exposed a secret value.");
  }

  const productionTemplate = await readDeploymentManifest(path.join(root, "infra", "media", "deployment.production.example.json"));
  const productionManifest = structuredClone(productionTemplate);
  productionManifest.livekit.publicUrl = "wss://media.acme.co.kr";
  productionManifest.livekit.workerUrl = "wss://media-internal.acme.co.kr";
  productionManifest.livekit.redisAddress = "redis-internal.acme.co.kr:6379";
  productionManifest.livekit.turn.domain = "turn.acme.co.kr";
  productionManifest.storage.endpoint = "https://objects.acme.co.kr";
  productionManifest.storage.verificationEndpoint = "https://objects.acme.co.kr";
  productionManifest.webhookUrl = "https://api.acme.co.kr/provider/livekit/webhook";
  const productionSecrets = {
    LIVEKIT_API_KEY: "ACME_MEDIA_KEY_2026",
    LIVEKIT_API_SECRET: "a".repeat(48),
    REDIS_PASSWORD: "b".repeat(48),
    LIVEKIT_EGRESS_S3_ACCESS_KEY: "ACME_EGRESS_WRITE_01",
    LIVEKIT_EGRESS_S3_SECRET_KEY: "c".repeat(48),
    MINIO_ROOT_USER: "",
    MINIO_ROOT_PASSWORD: ""
  };
  const productionOutput = path.join(tempRoot, "production");
  await renderMediaDeployment({ manifest: productionManifest, outputDirectory: productionOutput, secrets: productionSecrets });
  const productionLivekit = parseYaml(await readFile(path.join(productionOutput, "livekit.yaml"), "utf8"));
  const productionEgress = parseYaml(await readFile(path.join(productionOutput, "egress.yaml"), "utf8"));
  assert(productionLivekit.rtc.use_external_ip === true && productionLivekit.turn.enabled === true, "Production renderer omitted external IP or TURN/TLS.");
  assert(productionEgress.insecure === false && productionEgress.ws_url.startsWith("wss://"), "Production Egress renderer allowed an insecure worker URL.");

  const insecureSignal = structuredClone(productionManifest);
  insecureSignal.livekit.publicUrl = "ws://media.acme.co.kr";
  expectInvalid(insecureSignal, productionSecrets, /livekit\.publicUrl must use wss:/);
  const loopbackSignal = structuredClone(productionManifest);
  loopbackSignal.livekit.publicUrl = "wss://127.0.0.1:7880";
  expectInvalid(loopbackSignal, productionSecrets, /real non-loopback production host/);
  const insecureStorage = structuredClone(productionManifest);
  insecureStorage.storage.endpoint = "http://objects.acme.co.kr";
  expectInvalid(insecureStorage, productionSecrets, /storage\.endpoint must use https:/);
  const sharedTurnDomain = structuredClone(productionManifest);
  sharedTurnDomain.livekit.turn.domain = "media.acme.co.kr";
  expectInvalid(sharedTurnDomain, productionSecrets, /TURN must use a separate hostname/);
  const malformedTurnDomain = structuredClone(productionManifest);
  malformedTurnDomain.livekit.turn.domain = "https://turn.acme.co.kr";
  expectInvalid(malformedTurnDomain, productionSecrets, /real non-loopback hostname/);
  const invalidRedisPort = structuredClone(productionManifest);
  invalidRedisPort.livekit.redisAddress = "redis-internal.acme.co.kr:99999";
  expectInvalid(invalidRedisPort, productionSecrets, /redisAddress/);
  expectInvalid(productionManifest, { ...productionSecrets, LIVEKIT_API_SECRET: "replace_me" }, /LIVEKIT_API_SECRET/);

  const composeText = await readFile(path.join(root, "infra", "media", "compose.smoke.yaml"), "utf8");
  const compose = parseYaml(composeText);
  assert(compose.services.redis.image === "redis:8.8.0-alpine3.23@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005", "Redis smoke image is not digest-pinned.");
  assert(compose.services.livekit.image === "livekit/livekit-server:v1.13.3@sha256:483b8b7b5b0654f91f1e8bdc7b46fcd37fd9911612ecf627f97e3185a89825bd", "LiveKit smoke image is not digest-pinned.");
  assert(compose.services.egress.image === "livekit/egress:v1.12.0@sha256:30b3389518c851e6c20e964bba9d5ce89d0bd09b8b0fe0d0d36c9546303c8430", "Egress smoke image is not digest-pinned.");
  assert(compose.services.minio.image === "quay.io/minio/minio:RELEASE.2025-06-13T11-33-47Z@sha256:064117214caceaa8d8a90ef7caa58f2b2aeb316b5156afe9ee8da5b4d83e12c8", "MinIO smoke image is not digest-pinned.");
  assert(compose.services["minio-provision"].image === "minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727", "MinIO client smoke image is not digest-pinned.");
  assert(compose.services.egress.cap_add.includes("SYS_ADMIN"), "Room Composite Egress is missing the documented Chrome capability.");
  assert(compose.services.redis.env_file.length === 1 && compose.services.redis.env_file[0] === "./runtime/redis.env", "Redis does not use its isolated environment file.");
  assert(compose.services.minio.env_file.length === 1 && compose.services.minio.env_file[0] === "./runtime/minio.env", "MinIO does not use its isolated environment file.");
  assert(compose.services["minio-provision"].env_file.length === 1 && compose.services["minio-provision"].env_file[0] === "./runtime/provision.env", "Storage provisioning does not use its isolated environment file.");
  assert(compose.services.minio.ports.every((mapping) => mapping.startsWith("127.0.0.1:")), "MinIO smoke ports are exposed beyond loopback.");
  assert(compose.services.livekit.ports.every((mapping) => mapping.startsWith("127.0.0.1:")), "LiveKit smoke ports are exposed beyond loopback.");
  assert(compose.services.egress.ports.every((mapping) => mapping.startsWith("127.0.0.1:")), "Egress smoke health ports are exposed beyond loopback.");
  assert(!/devkey|hahatalk_dev_only|replace_me/i.test(composeText), "Smoke Compose contains a fixed credential or placeholder secret.");
  const provisionText = await readFile(path.join(root, "infra", "media", "provision-minio.sh"), "utf8");
  assert(provisionText.includes("mc anonymous set none"), "Smoke storage provisioning does not explicitly deny anonymous access.");
  assert(provisionText.includes("mc ilm rule add") && provisionText.includes("--prefix recordings/"), "Smoke storage provisioning does not apply recording-prefix retention.");
  const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
  for (const ignored of ["infra/media/runtime/", "infra/media/smoke-artifacts/", "infra/media/secrets/"]) {
    assert(gitignore.includes(ignored), `${ignored} is not ignored by Git.`);
  }

  console.log("Media infrastructure configuration passed: production TLS/TURN validation, shared Redis, digest-pinned services, isolated secrets, private non-listing upload-only storage, lifecycle, redaction, and loopback exposure verified.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
