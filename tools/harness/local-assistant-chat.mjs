import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
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
const databaseName = `hahatalk_assistant_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_assistant_session";
const assistantSpaceId = "00000000-0000-4000-8000-000000000204";
const assistantUserId = "assistant-hahatalk-ai";
const clientHeader = { "X-HahaTalk-Client": "web-v1" };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function availablePort() {
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

async function startFakeOllama(port) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/chat") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(payload);
    const latest = payload.messages.at(-1)?.content ?? "";
    await delay(latest.includes("FAIL_ASSISTANT") ? 30 : 700);
    if (latest.includes("FAIL_ASSISTANT")) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "deterministic harness failure" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      done: true,
      message: { content: "안녕하세요. 로컬 Qwen 통합 테스트 응답입니다.", role: "assistant" },
      model: payload.model
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { requests, server };
}

async function startApi(port, webOrigin, ollamaUrl) {
  const logs = [];
  const child = spawn(process.execPath, [apiEntry], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HAHATALK_ALLOW_OPEN_SIGNUP: "true",
      HAHATALK_MIGRATIONS_DIR: migrationsDirectory,
      HAHATALK_OLLAMA_MODEL: "qwen3.5:4b",
      HAHATALK_OLLAMA_TIMEOUT_MS: "5000",
      HAHATALK_OLLAMA_URL: ollamaUrl,
      PORT: String(port),
      SESSION_COOKIE_NAME: cookieName,
      WEB_ORIGIN: webOrigin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Assistant API exited.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // Migrations or listener startup are still in progress.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Assistant API did not become healthy.\n${logs.join("")}`);
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
  if (origin) headers.Origin = origin;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    Object.assign(headers, clientHeader);
  }
  const response = await fetch(`${baseUrl}${pathName}`, {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers,
    method,
    signal: AbortSignal.timeout(8_000)
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { body, response };
}

async function signup(baseUrl, webOrigin) {
  const result = await request(baseUrl, "/auth/signup", {
    method: "POST",
    origin: webOrigin,
    payload: {
      characterId: "char-calm-lead",
      displayName: "Assistant Test Owner",
      email: "you@inviz.co.kr",
      password: "Stage17!AssistantOwner"
    }
  });
  assert(result.response.status === 201, `Assistant owner signup failed: ${result.response.status}.`);
  const cookie = result.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "Assistant owner cookie is missing.");
  return { cookie, userId: result.body.user.id };
}

function connectSocket(baseUrl, webOrigin, cookie) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      extraHeaders: { Cookie: cookie, Origin: webOrigin },
      forceNew: true,
      reconnection: false,
      transports: ["websocket"]
    });
    socket.once("connect_error", reject);
    socket.once("connect", () => {
      socket.timeout(3_000).emit("room:join", { spaceId: assistantSpaceId }, (error) => {
        if (error) reject(error);
        else resolve(socket);
      });
    });
  });
}

function waitForEvent(socket, event, predicate, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`${event} timed out.`));
    }, timeout);
    const listener = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function send(baseUrl, webOrigin, cookie, body, clientMessageId = `assistant-${randomUUID()}`) {
  const started = performance.now();
  const result = await request(baseUrl, "/messages", {
    cookie,
    method: "POST",
    origin: webOrigin,
    payload: {
      audienceType: "all",
      body,
      clientMessageId,
      requiresConfirmation: false,
      spaceId: assistantSpaceId,
      targetUserIds: []
    }
  });
  assert(result.response.status === 201, `Assistant message send failed: ${JSON.stringify(result.body)}`);
  return { ...result.body, elapsedMs: performance.now() - started };
}

const adminDatabase = new Client({ connectionString: adminUrl.toString() });
const database = new Client({ connectionString: databaseUrl });
let adminConnected = false;
let databaseConnected = false;
let api;
let ollama;
let socket;

try {
  await adminDatabase.connect();
  adminConnected = true;
  await adminDatabase.query(`create database "${databaseName}"`);
  await database.connect();
  databaseConnected = true;
  const ollamaPort = await availablePort();
  ollama = await startFakeOllama(ollamaPort);
  const apiPort = await availablePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${await availablePort()}`;
  api = await startApi(apiPort, webOrigin, `http://127.0.0.1:${ollamaPort}`);
  const owner = await signup(baseUrl, webOrigin);

  const initial = await request(baseUrl, `/spaces/${assistantSpaceId}/view`, { cookie: owner.cookie });
  assert(initial.response.status === 200, "Assistant direct room is unavailable.");
  assert(initial.body.room.title === "HahaTalk AI", "Assistant room title is incorrect.");
  assert(initial.body.room.assistant?.model === "Qwen3.5-4B", "Assistant room did not expose its model label.");
  assert(initial.body.users.length === 2 && initial.body.users.some((user) => user.id === assistantUserId), "Assistant room membership is unsafe.");

  socket = await connectSocket(baseUrl, webOrigin, owner.cookie);
  const typingStarted = waitForEvent(socket, "typing:updated", (value) => value.userId === assistantUserId && value.active === true);
  const assistantCreated = waitForEvent(socket, "message:created", (value) => value.senderId === assistantUserId);
  const sent = await send(baseUrl, webOrigin, owner.cookie, "비동기 응답 경로를 확인해 줘.");
  assert(sent.elapsedMs < 500, `Chat waited for model inference (${sent.elapsedMs.toFixed(1)}ms).`);
  await typingStarted;
  const reply = await assistantCreated;
  assert(reply.body === "안녕하세요. 로컬 Qwen 통합 테스트 응답입니다.", "Assistant reply body is incorrect.");
  assert(reply.metadata.assistant === true && reply.metadata.model === "Qwen3.5-4B", "Assistant provenance metadata is missing.");
  assert(ollama.requests[0]?.model === "qwen3.5:4b", "Assistant used the wrong Ollama model.");
  assert(ollama.requests[0]?.think === false, "Assistant did not suppress private thinking output.");
  assert(ollama.requests[0]?.messages.some((message) => message.role === "system"), "Assistant system boundary is missing.");

  const job = await database.query(
    `select status, input_json, result_json, error_code
     from ai_jobs where job_type = 'assistant' order by created_at limit 1`
  );
  assert(job.rows[0]?.status === "succeeded", "Assistant job did not persist success.");
  assert(Object.keys(job.rows[0].input_json).join(",") === "sourceMessageId", "Assistant job duplicated chat text into its queue payload.");

  const replayId = `assistant-replay-${randomUUID()}`;
  await send(baseUrl, webOrigin, owner.cookie, "idempotent assistant", replayId);
  await delay(1_200);
  const beforeReplay = await database.query("select count(*)::int as count from ai_jobs where idempotency_key like 'assistant-reply-%'");
  await send(baseUrl, webOrigin, owner.cookie, "idempotent assistant", replayId);
  await delay(100);
  const afterReplay = await database.query("select count(*)::int as count from ai_jobs where idempotency_key like 'assistant-reply-%'");
  assert(beforeReplay.rows[0].count === afterReplay.rows[0].count, "Message replay queued a duplicate assistant job.");

  const failure = waitForEvent(socket, "message:created", (value) => value.senderId === assistantUserId && value.metadata.assistantError === true, 12_000);
  await send(baseUrl, webOrigin, owner.cookie, "FAIL_ASSISTANT");
  const failureMessage = await failure;
  assert(failureMessage.body.includes("로컬 AI 응답을 만들지 못했습니다"), "Assistant failure was not explicit.");
  const failedJob = await database.query(
    "select status, error_code from ai_jobs where job_type = 'assistant' order by created_at desc limit 1"
  );
  assert(failedJob.rows[0]?.status === "failed" && failedJob.rows[0]?.error_code === "assistant_unavailable", "Assistant failure state is not durable.");

  console.log(JSON.stringify({
    assistantModel: ollama.requests[0].model,
    chatSendMs: Number(sent.elapsedMs.toFixed(1)),
    failureVisible: true,
    queuedInputKeys: Object.keys(job.rows[0].input_json),
    realtimeReply: true
  }, null, 2));
} finally {
  socket?.close();
  await stopApi(api);
  if (ollama?.server) await new Promise((resolve) => ollama.server.close(resolve));
  if (databaseConnected) await database.end().catch(() => undefined);
  if (adminConnected) {
    await adminDatabase.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [databaseName]
    ).catch(() => undefined);
    await adminDatabase.query(`drop database if exists "${databaseName}"`).catch(() => undefined);
    await adminDatabase.end().catch(() => undefined);
  }
}
