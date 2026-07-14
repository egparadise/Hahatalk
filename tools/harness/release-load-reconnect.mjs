import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { io } from "socket.io-client";

const root = process.cwd();
const apiEntry = path.join(root, "apps", "api", "dist", "main.js");
const migrationsDirectory = path.join(root, "apps", "api", "migrations");
const baseDatabaseUrl = process.env.DATABASE_URL
  ?? "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const databaseName = `hahatalk_load_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = `hahatalk_load_${randomUUID().slice(0, 8)}`;
const messageCount = 30;
const maxMessageP95Ms = 2_000;
const maxReconnectP95Ms = 2_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

async function availablePort() {
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

async function startApi(port, webOrigin) {
  const logs = [];
  const child = spawn(process.execPath, [apiEntry], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HAHATALK_ALLOW_OPEN_SIGNUP: "true",
      HAHATALK_MIGRATIONS_DIR: migrationsDirectory,
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
    if (child.exitCode !== null) throw new Error(`Load API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ops/health/ready`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // Fresh migrations can take several seconds.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Load API did not become ready.\n${logs.join("")}`);
}

async function stopApi(api) {
  if (!api?.child || api.child.exitCode !== null) return;
  api.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => api.child.once("exit", resolve)),
    delay(5_000).then(() => api.child.exitCode === null && api.child.kill())
  ]);
}

async function request(baseUrl, pathName, { cookie, method = "GET", origin, payload } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) {
    headers.Origin = origin;
    headers["X-HahaTalk-Client"] = "web-v1";
  }
  let body;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${pathName}`, {
    body,
    headers,
    method,
    signal: AbortSignal.timeout(30_000)
  });
  const latencyMs = performance.now() - startedAt;
  const contentType = response.headers.get("content-type") ?? "";
  const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();
  return { body: responseBody, latencyMs, response };
}

async function signup(baseUrl, origin) {
  const result = await request(baseUrl, "/auth/signup", {
    method: "POST",
    origin,
    payload: {
      characterId: "char-calm-lead",
      displayName: "Stage11 Load Owner",
      email: "you@inviz.co.kr",
      password: "Stage11!LoadOwner"
    }
  });
  assert(result.response.status === 201, `Load signup failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  const setCookie = result.response.headers.get("set-cookie");
  assert(setCookie, "Load signup did not set a cookie.");
  return { cookie: setCookie.split(";", 1)[0], state: result.body };
}

async function mapLimit(items, concurrency, work) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function reconnect(baseUrl, cookie, spaceId) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      extraHeaders: { Cookie: cookie },
      forceNew: true,
      reconnection: false,
      transports: ["websocket"]
    });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Socket reconnect timed out."));
    }, 8_000);
    socket.once("connect", () => socket.emit("room:join", { limit: 50, spaceId }));
    socket.once("room:snapshot", (snapshot) => {
      clearTimeout(timeout);
      socket.close();
      resolve({ latencyMs: performance.now() - startedAt, snapshot });
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      socket.close();
      reject(error);
    });
  });
}

const adminDatabase = new Client({ connectionString: adminUrl.toString() });
const database = new Client({ connectionString: databaseUrl });
let adminConnected = false;
let databaseConnected = false;
let api;

try {
  await adminDatabase.connect();
  adminConnected = true;
  await adminDatabase.query(`create database "${databaseName}"`);
  await database.connect();
  databaseConnected = true;
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const origin = `http://127.0.0.1:${await availablePort()}`;
  api = await startApi(port, origin);
  const owner = await signup(baseUrl, origin);
  const spaceId = owner.state.roomId;
  assert(typeof spaceId === "string", "Owner session has no default space.");

  const ids = Array.from({ length: messageCount }, () => randomUUID());
  const firstPass = await mapLimit(ids, 6, async (clientMessageId, index) => {
    const result = await request(baseUrl, "/messages", {
      cookie: owner.cookie,
      method: "POST",
      origin,
      payload: {
        audienceType: "all",
        body: `Stage 11 bounded load message ${index + 1}`,
        clientMessageId,
        spaceId,
        targetUserIds: []
      }
    });
    assert(result.response.status === 201, `Message load request failed: ${result.response.status} ${JSON.stringify(result.body)}`);
    return result.latencyMs;
  });
  const replayPass = await mapLimit(ids, 6, async (clientMessageId, index) => {
    const result = await request(baseUrl, "/messages", {
      cookie: owner.cookie,
      method: "POST",
      origin,
      payload: {
        audienceType: "all",
        body: `Stage 11 bounded load message ${index + 1}`,
        clientMessageId,
        spaceId,
        targetUserIds: []
      }
    });
    assert(result.response.status === 201, `Idempotent replay failed: ${result.response.status} ${JSON.stringify(result.body)}`);
    return result.latencyMs;
  });
  const messageLatencies = [...firstPass, ...replayPass];
  const messageP95Ms = percentile(messageLatencies, 0.95);
  assert(messageP95Ms <= maxMessageP95Ms, `Message p95 ${messageP95Ms.toFixed(1)}ms exceeds ${maxMessageP95Ms}ms.`);
  const persisted = await database.query(
    "select count(*)::text as count from messages where client_message_id = any($1::text[])",
    [ids]
  );
  assert(Number(persisted.rows[0]?.count) === messageCount, "Idempotent message replay created duplicates.");

  const reconnects = await mapLimit(Array.from({ length: 20 }, (_, index) => index), 5, () => reconnect(baseUrl, owner.cookie, spaceId));
  const reconnectLatencies = reconnects.map((result) => result.latencyMs);
  const reconnectP95Ms = percentile(reconnectLatencies, 0.95);
  assert(reconnectP95Ms <= maxReconnectP95Ms, `Reconnect p95 ${reconnectP95Ms.toFixed(1)}ms exceeds ${maxReconnectP95Ms}ms.`);
  assert(reconnects.every((result) => Array.isArray(result.snapshot.messages)), "Reconnect snapshot is malformed.");

  await stopApi(api);
  api = await startApi(port, origin);
  const afterRestart = await request(baseUrl, `/mvp?spaceId=${spaceId}&limit=50`, {
    cookie: owner.cookie,
    origin
  });
  assert(afterRestart.response.status === 200, `Restart snapshot failed: ${afterRestart.response.status}`);
  const visibleIds = new Set(afterRestart.body.messages.map((message) => message.id));
  assert(visibleIds.size >= messageCount, "Restart snapshot lost persisted messages.");

  console.log(
    `Release load/reconnect passed: ${messageCount} unique + ${messageCount} idempotent replay requests, `
    + `message p95 ${messageP95Ms.toFixed(1)}ms, 20 authenticated reconnects p95 ${reconnectP95Ms.toFixed(1)}ms, zero errors.`
  );
} finally {
  await stopApi(api).catch(() => undefined);
  if (databaseConnected) await database.end().catch(() => undefined);
  if (adminConnected) {
    await adminDatabase.query(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    await adminDatabase.end().catch(() => undefined);
  }
}
