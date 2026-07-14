import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Client } from "pg";
import { RoomServiceClient } from "livekit-server-sdk";
import {
  generateSmokeSecrets,
  readDeploymentManifest,
  renderMediaDeployment
} from "../infra/media-deployment-lib.mjs";

const root = path.resolve(process.cwd());
const mediaRoot = path.resolve(root, "infra", "media");
const runtimeDirectory = path.resolve(mediaRoot, "runtime");
const composePath = path.resolve(mediaRoot, "compose.smoke.yaml");
const manifestPath = path.resolve(mediaRoot, "deployment.smoke.json");
const composeProject = "hahatalk-media-smoke";
const apiEntry = path.join(root, "apps", "api", "dist", "main.js");
const migrationsDirectory = path.join(root, "apps", "api", "migrations");
const directSpaceId = "00000000-0000-4000-8000-000000000203";
const cookieName = "hahatalk_media_infra_session";
const baseDatabaseUrl = process.env.DATABASE_URL
  ?? "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const databaseName = `hahatalk_media_infra_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ensureSafeRuntimePath() {
  const expectedPrefix = `${mediaRoot}${path.sep}`;
  assert(runtimeDirectory.startsWith(expectedPrefix), "Media runtime cleanup escaped infra/media.");
  assert(path.basename(runtimeDirectory) === "runtime", "Media runtime cleanup target is not the expected runtime directory.");
}

async function availableTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function runCommand(executable, args, { allowFailure = false, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const result = { code: code ?? -1, output: output.join(""), signal };
      if (!allowFailure && result.code !== 0) {
        reject(new Error(`${executable} ${args.join(" ")} failed (${result.code}${signal ? `/${signal}` : ""}).\n${result.output}`));
        return;
      }
      resolve(result);
    });
  });
}

async function compose(args, options) {
  return runCommand("docker", ["compose", "--project-name", composeProject, "-f", composePath, ...args], options);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000).then(() => child.exitCode === null && child.kill())
  ]);
}

async function startApi(port, webOrigin, manifest, secrets) {
  const logs = [];
  const child = spawn(process.execPath, [apiEntry], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HAHATALK_ALLOW_OPEN_SIGNUP: "true",
      HAHATALK_MIGRATIONS_DIR: migrationsDirectory,
      HAHATALK_TEST_MEDIA_INFRA: "1",
      LIVEKIT_URL: manifest.livekit.publicUrl,
      LIVEKIT_API_KEY: secrets.LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET: secrets.LIVEKIT_API_SECRET,
      LIVEKIT_EGRESS_ENABLED: "1",
      LIVEKIT_EGRESS_S3_ACCESS_KEY: secrets.LIVEKIT_EGRESS_S3_ACCESS_KEY,
      LIVEKIT_EGRESS_S3_SECRET_KEY: secrets.LIVEKIT_EGRESS_S3_SECRET_KEY,
      LIVEKIT_EGRESS_S3_BUCKET: manifest.storage.bucket,
      LIVEKIT_EGRESS_S3_REGION: manifest.storage.region,
      LIVEKIT_EGRESS_S3_ENDPOINT: manifest.storage.endpoint,
      LIVEKIT_EGRESS_S3_FORCE_PATH_STYLE: "1",
      NODE_ENV: "test",
      PORT: String(port),
      SESSION_COOKIE_NAME: cookieName,
      WEB_ORIGIN: webOrigin
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Media smoke API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // Fresh database migration is still running.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Media smoke API did not become healthy.\n${logs.join("")}`);
}

async function request(baseUrl, pathname, { cookie, method = "GET", origin, payload } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-HahaTalk-Client"] = "web-v1";
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers,
    method,
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { body, response };
}

function responseCookie(response) {
  const value = response.headers.get("set-cookie");
  assert(value, "Authentication response did not set a cookie.");
  return value.split(";", 1)[0];
}

async function signup(baseUrl, origin, email, displayName, characterId) {
  const result = await request(baseUrl, "/auth/signup", {
    method: "POST",
    origin,
    payload: { characterId, displayName, email, password: "Stage6F!MediaInfra2026" }
  });
  assert(result.response.status === 201, `Signup failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  return { cookie: responseCookie(result.response), userId: result.body.user.id };
}

async function post(baseUrl, origin, cookie, pathname, payload = {}, expected = 200) {
  const result = await request(baseUrl, pathname, { cookie, method: "POST", origin, payload });
  assert(result.response.status === expected, `${pathname} expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function waitForRecording(baseUrl, cookie, callId, statuses, attempts = 180) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await request(baseUrl, `/calls/${callId}`, { cookie });
    assert(result.response.status === 200, `Call projection failed while waiting for recording: ${result.response.status}`);
    if (statuses.includes(result.body.recording?.status)) return result.body.recording;
    if (["failed", "aborted", "consent_denied"].includes(result.body.recording?.status)) {
      throw new Error(`Recording entered ${result.body.recording.status}: ${result.body.recording.failureCode ?? "unknown"}`);
    }
    await delay(500);
  }
  throw new Error(`Recording did not reach ${statuses.join("/")}.`);
}

async function expectS3Denied(client, command) {
  try {
    await client.send(command);
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 401 || status === 403 || ["AccessDenied", "Forbidden"].includes(error?.name)) return;
    throw error;
  }
  throw new Error("Upload-only Egress credentials unexpectedly read a recording object.");
}

ensureSafeRuntimePath();
const manifest = await readDeploymentManifest(manifestPath);
const secrets = generateSmokeSecrets();
const adminDatabase = new Client({ connectionString: adminUrl.toString() });
const database = new Client({ connectionString: databaseUrl });
let adminConnected = false;
let databaseConnected = false;
let api;
let composeStarted = false;
let dockerReady = false;
let failureLogs = "";

try {
  await rm(runtimeDirectory, { recursive: true, force: true });
  await renderMediaDeployment({ manifest, outputDirectory: runtimeDirectory, secrets });

  let dockerVersion;
  try {
    dockerVersion = await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 20_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Docker Linux engine is unavailable. Start or repair Docker Desktop, then rerun npm run media-infra:smoke.\n${detail}`);
  }
  assert(dockerVersion.output.trim(), "Docker Linux engine did not report a server version.");
  dockerReady = true;
  await compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true, timeoutMs: 60_000 });
  await compose(["up", "-d", "--wait", "--wait-timeout", "240"], { timeoutMs: 900_000 });
  composeStarted = true;

  const egressHealth = await fetch("http://127.0.0.1:8091/", { signal: AbortSignal.timeout(5_000) });
  assert(egressHealth.ok, `Egress health endpoint returned ${egressHealth.status}.`);
  const livekitServiceUrl = manifest.livekit.publicUrl.replace("ws:", "http:").replace("wss:", "https:");
  const livekitClient = new RoomServiceClient(livekitServiceUrl, secrets.LIVEKIT_API_KEY, secrets.LIVEKIT_API_SECRET, { failover: false, requestTimeout: 3 });
  await livekitClient.listRooms();

  await runCommand("powershell", ["-ExecutionPolicy", "Bypass", "-File", "tools/dev/portable-postgres.ps1", "-Action", "Start"], { timeoutMs: 120_000 });
  await runCommand("npm", ["run", "build", "-w", "packages/contracts"], { timeoutMs: 120_000 });
  await runCommand("npm", ["run", "build", "-w", "apps/api"], { timeoutMs: 120_000 });

  await adminDatabase.connect();
  adminConnected = true;
  await adminDatabase.query(`create database "${databaseName}"`);
  await database.connect();
  databaseConnected = true;

  const apiPort = await availableTcpPort();
  const webPort = await availableTcpPort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  api = await startApi(apiPort, webOrigin, manifest, secrets);

  const owner = await signup(baseUrl, webOrigin, "media-owner@inviz.co.kr", "Media Infra Owner", "char-calm-lead");
  const participant = await signup(baseUrl, webOrigin, "media-participant@inviz.co.kr", "Media Infra Participant", "char-focus-maker");
  const call = await post(baseUrl, webOrigin, owner.cookie, "/calls", {
    callType: "video",
    clientCallId: `media-infra-${randomUUID()}`,
    spaceId: directSpaceId,
    targetUserIds: [participant.userId]
  }, 201);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${call.id}/join`);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${call.id}/connected`);
  await post(baseUrl, webOrigin, participant.cookie, `/calls/${call.id}/join`);
  await post(baseUrl, webOrigin, participant.cookie, `/calls/${call.id}/connected`);

  const requested = await post(baseUrl, webOrigin, owner.cookie, `/calls/${call.id}/recording/request`);
  assert(requested.participants.length === 2 && requested.status === "consent_pending", "Real Egress request did not capture both joined participants.");
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${call.id}/recording/consent`, {
    decision: "granted",
    policyVersion: requested.policyVersion
  });
  await post(baseUrl, webOrigin, participant.cookie, `/calls/${call.id}/recording/consent`, {
    decision: "granted",
    policyVersion: requested.policyVersion
  });
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${call.id}/recording/start`);
  await waitForRecording(baseUrl, owner.cookie, call.id, ["recording"]);
  await delay(4_000);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${call.id}/recording/stop`, { reason: "host_stopped" });
  const completed = await waitForRecording(baseUrl, owner.cookie, call.id, ["ready"], 240);

  const stored = await database.query(
    `select output_object_key, output_size_bytes, output_duration_seconds, provider_egress_id
     from call_recordings where id = $1`,
    [completed.id]
  );
  assert(stored.rowCount === 1, "Completed recording metadata was not persisted.");
  const objectKey = stored.rows[0].output_object_key;
  assert(/^recordings\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+[.]mp4$/.test(objectKey), "Recording object key escaped its private prefix.");
  assert(Number(stored.rows[0].output_size_bytes) > 1_024, "Provider did not report a non-empty MP4.");
  assert(Number(stored.rows[0].output_duration_seconds) > 0, "Provider did not report a positive recording duration.");

  const rootS3 = new S3Client({
    endpoint: manifest.storage.verificationEndpoint,
    forcePathStyle: true,
    region: manifest.storage.region,
    credentials: { accessKeyId: secrets.MINIO_ROOT_USER, secretAccessKey: secrets.MINIO_ROOT_PASSWORD }
  });
  const egressS3 = new S3Client({
    endpoint: manifest.storage.verificationEndpoint,
    forcePathStyle: true,
    region: manifest.storage.region,
    credentials: {
      accessKeyId: secrets.LIVEKIT_EGRESS_S3_ACCESS_KEY,
      secretAccessKey: secrets.LIVEKIT_EGRESS_S3_SECRET_KEY
    }
  });
  const head = await rootS3.send(new HeadObjectCommand({ Bucket: manifest.storage.bucket, Key: objectKey }));
  assert(Number(head.ContentLength) > 1_024 && head.Metadata?.["hahatalk-recording-id"] === completed.id, "Stored MP4 metadata or size is incorrect.");
  await expectS3Denied(egressS3, new GetObjectCommand({ Bucket: manifest.storage.bucket, Key: objectKey }));
  const anonymous = await fetch(`${manifest.storage.verificationEndpoint}/${manifest.storage.bucket}/${objectKey}`, { signal: AbortSignal.timeout(5_000) });
  assert([401, 403].includes(anonymous.status), `Anonymous recording read returned ${anonymous.status}.`);
  const lifecycle = await rootS3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: manifest.storage.bucket }));
  assert(lifecycle.Rules?.some((rule) => rule.Expiration?.Days === manifest.storage.retentionDays), "Recording bucket lifecycle does not match the retention manifest.");
  const object = await rootS3.send(new GetObjectCommand({ Bucket: manifest.storage.bucket, Key: objectKey }));
  const bytes = await object.Body.transformToByteArray();
  assert(bytes.length > 1_024 && Buffer.from(bytes.slice(4, 8)).toString("ascii") === "ftyp", "Stored recording is not an MP4/ISO BMFF object.");

  await rootS3.send(new DeleteObjectCommand({ Bucket: manifest.storage.bucket, Key: objectKey }));
  let deleted = false;
  try {
    await rootS3.send(new HeadObjectCommand({ Bucket: manifest.storage.bucket, Key: objectKey }));
  } catch (error) {
    deleted = [404, 403].includes(error?.$metadata?.httpStatusCode) || ["NotFound", "NoSuchKey"].includes(error?.name);
  }
  assert(deleted, "Smoke recording object was not removed after verification.");
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${call.id}/end`);
  assert((await livekitClient.listRooms()).length === 0, "LiveKit room remained after the verified recording call ended.");

  console.log(`Real media infrastructure smoke passed: Room Composite MP4 ${bytes.length} bytes, private upload-only storage, ${manifest.storage.retentionDays}-day lifecycle, provider metadata, cleanup, and zero remaining rooms verified.`);
} catch (error) {
  if (composeStarted) {
    const logs = await compose(["logs", "--no-color", "--tail", "200"], { allowFailure: true, timeoutMs: 60_000 });
    failureLogs = logs.output;
  }
  const message = error instanceof Error ? error.stack || error.message : String(error);
  throw new Error(`${message}${failureLogs ? `\n--- media stack logs ---\n${failureLogs}` : ""}`);
} finally {
  await stopChild(api?.child).catch(() => undefined);
  if (databaseConnected) await database.end().catch(() => undefined);
  if (adminConnected) {
    await adminDatabase.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [databaseName]
    ).catch(() => undefined);
    await adminDatabase.query(`drop database if exists "${databaseName}"`).catch(() => undefined);
    await adminDatabase.end().catch(() => undefined);
  }
  if (dockerReady) {
    await compose(["down", "--volumes", "--remove-orphans"], { allowFailure: true, timeoutMs: 120_000 }).catch(() => undefined);
  }
  await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
}
