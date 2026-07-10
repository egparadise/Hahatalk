import { createHash, randomUUID } from "node:crypto";
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
const integrationDatabaseName = `hahatalk_test_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${integrationDatabaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_integration_session";
const password = "Stage2!Persistence";
const email = `stage2-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
const displayName = "Stage2 Test User";
const clientHeader = { "X-HahaTalk-Client": "web-v1" };

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function findAvailablePort() {
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
      PORT: String(port),
      SESSION_COOKIE_NAME: cookieName,
      WEB_ORIGIN: webOrigin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`HahaTalk API exited during startup.\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) {
        return { child, logs };
      }
    } catch {
      // The API is still applying migrations or opening the listener.
    }
    await delay(125);
  }

  child.kill();
  throw new Error(`HahaTalk API did not become healthy.\n${logs.join("")}`);
}

async function stopApi(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill();
      }
    })
  ]);
}

async function request(baseUrl, pathName, { cookie, method = "GET", origin, payload } = {}) {
  const headers = {};
  if (cookie) {
    headers.Cookie = cookie;
  }
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    Object.assign(headers, clientHeader);
  }
  if (origin) {
    headers.Origin = origin;
  }

  const response = await fetch(`${baseUrl}${pathName}`, {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers,
    method,
    signal: AbortSignal.timeout(5_000)
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { body, response };
}

function cookieFrom(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert(setCookie.includes("HttpOnly"), "Session cookie must be HttpOnly.");
  assert(setCookie.includes("SameSite=Strict"), "Session cookie must use SameSite=Strict.");
  const cookie = setCookie.split(";", 1)[0];
  assert(cookie.startsWith(`${cookieName}=`), "Expected session cookie was not set.");
  return { cookie, setCookie };
}

async function expectSocketRejection(baseUrl, webOrigin) {
  const socket = io(baseUrl, {
    extraHeaders: { Origin: webOrigin },
    forceNew: true,
    reconnection: false,
    timeout: 2_000,
    transports: ["websocket"]
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", () => reject(new Error("Unauthenticated Socket.IO connection was accepted.")));
      socket.once("connect_error", resolve);
      setTimeout(() => reject(new Error("Unauthenticated Socket.IO connection did not settle.")), 3_000).unref();
    });
  } finally {
    socket.close();
  }
}

async function verifyAuthenticatedSocket(baseUrl, webOrigin, cookie, expectedUserId) {
  const socket = io(baseUrl, {
    extraHeaders: { Cookie: cookie, Origin: webOrigin },
    forceNew: true,
    reconnection: false,
    timeout: 3_000,
    transports: ["websocket"]
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    const snapshotPromise = new Promise((resolve, reject) => {
      socket.once("room:snapshot", resolve);
      setTimeout(() => reject(new Error("Authenticated Socket.IO room snapshot timed out.")), 3_000).unref();
    });
    socket.emit("room:join", { userId: "user-you" });
    const snapshot = await snapshotPromise;
    assert(snapshot.room.mode === "direct", "Socket.IO room join trusted a client userId.");

    const message = await new Promise((resolve, reject) => {
      socket.timeout(3_000).emit("message:send", {
        audienceType: "private",
        body: "Authenticated Socket.IO sender boundary",
        clientMessageId: `auth-socket-${randomUUID()}`,
        requiresConfirmation: false,
        senderId: "user-you",
        spaceId: snapshot.room.roomId,
        targetUserIds: ["user-you"]
      }, (error, response) => error ? reject(error) : resolve(response));
    });
    assert(message.message.senderId === expectedUserId, "Socket.IO message trusted a client senderId.");
  } finally {
    socket.close();
  }
}

const port = await findAvailablePort();
const webPort = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
let api;
let internalUserId;
const adminDatabase = new Client({ connectionString: adminUrl.toString() });
const database = new Client({ connectionString: databaseUrl });
let adminConnected = false;
let databaseConnected = false;

try {
  await adminDatabase.connect();
  adminConnected = true;
  await adminDatabase.query(`create database "${integrationDatabaseName}"`);
  await database.connect();
  databaseConnected = true;
  api = await startApi(port, webOrigin);

  const unauthenticated = await request(baseUrl, "/mvp");
  assert(unauthenticated.response.status === 401, "Protected API must reject an unauthenticated request.");

  const missingOrigin = await request(baseUrl, "/auth/login", {
    method: "POST",
    payload: { email, password }
  });
  assert(missingOrigin.response.status === 403, "State-changing API must reject a missing Origin.");

  const signup = await request(baseUrl, "/auth/signup", {
    method: "POST",
    origin: webOrigin,
    payload: {
      characterId: "char-focus-maker",
      displayName,
      email,
      password
    }
  });
  assert(signup.response.status === 201, `Signup failed with ${signup.response.status}.`);
  assert(!Object.hasOwn(signup.body, "token"), "Authentication response must not expose the cookie token.");
  const { cookie } = cookieFrom(signup.response);

  await expectSocketRejection(baseUrl, webOrigin);

  const me = await request(baseUrl, "/auth/me", { cookie });
  assert(me.response.status === 200, "The new session was not accepted by /auth/me.");
  assert(me.body.user.email === email, "The authenticated account does not match the signup email.");

  const spoofedSnapshot = await request(baseUrl, "/mvp?viewerId=user-you", { cookie });
  assert(spoofedSnapshot.response.status === 200, "Authenticated participant snapshot failed.");
  assert(spoofedSnapshot.body.room.mode === "direct", "viewerId query escalated a participant to owner view.");
  assert(spoofedSnapshot.body.users.length === 2, "Participant projection disclosed the hidden hub roster.");

  const spoofedMessage = await request(baseUrl, "/messages", {
    cookie,
    method: "POST",
    origin: webOrigin,
    payload: {
      audienceType: "private",
      body: "Authenticated sender boundary",
      clientMessageId: `auth-boundary-${randomUUID()}`,
      requiresConfirmation: false,
      senderId: "user-you",
      spaceId: spoofedSnapshot.body.room.roomId,
      targetUserIds: ["user-you"]
    }
  });
  assert(spoofedMessage.response.status === 201, "Authenticated message send failed.");
  assert(spoofedMessage.body.message.senderId === me.body.user.id, "Message senderId was accepted from the client body.");
  await verifyAuthenticatedSocket(baseUrl, webOrigin, cookie, me.body.user.id);

  const wrongPassword = await request(baseUrl, "/auth/login", {
    method: "POST",
    origin: webOrigin,
    payload: { email, password: "incorrect-password" }
  });
  assert(wrongPassword.response.status === 401, "Wrong password must return 401.");

  const account = await database.query(
    "select id, password_hash from users where email = $1",
    [email]
  );
  internalUserId = account.rows[0]?.id;
  assert(account.rows[0]?.password_hash?.startsWith("$argon2id$"), "Password is not stored as Argon2id.");
  const rawToken = cookie.slice(cookie.indexOf("=") + 1);
  const expectedHash = createHash("sha256").update(rawToken).digest("hex");
  const storedSession = await database.query(
    "select encode(token_hash, 'hex') as token_hash, octet_length(token_hash) as hash_bytes from web_sessions where user_id = $1 and revoked_at is null",
    [internalUserId]
  );
  assert(storedSession.rows[0]?.hash_bytes === 32, "Stored session digest must be 32 bytes.");
  assert(storedSession.rows[0]?.token_hash === expectedHash, "Server did not store the expected session digest.");
  assert(storedSession.rows[0]?.token_hash !== rawToken, "Database contains a reusable raw session token.");

  await stopApi(api.child);
  api = await startApi(port, webOrigin);

  const restored = await request(baseUrl, "/auth/me", { cookie });
  assert(restored.response.status === 200, "Session did not survive an API restart.");
  assert(restored.body.user.id === me.body.user.id, "Restart restored a different identity.");

  const logout = await request(baseUrl, "/auth/logout", {
    cookie,
    method: "POST",
    origin: webOrigin,
    payload: {}
  });
  assert(logout.response.status === 201 && logout.body.ok === true, "Logout failed.");
  const afterLogout = await request(baseUrl, "/auth/me", { cookie });
  assert(afterLogout.response.status === 401, "Revoked session remained usable after logout.");

  console.log("Auth persistence check passed: Argon2id, hashed cookie session, authenticated Socket.IO, restart restore, logout, origin, and identity spoof denial.");
} finally {
  if (api) {
    await stopApi(api.child);
  }
  if (databaseConnected && internalUserId) {
    await database.query("delete from audit_logs where actor_id = $1", [internalUserId]).catch(() => undefined);
    await database.query("delete from users where id = $1", [internalUserId]).catch(() => undefined);
  }
  if (databaseConnected) {
    await database.end().catch(() => undefined);
  }
  if (adminConnected) {
    await adminDatabase.query(`drop database if exists "${integrationDatabaseName}" with (force)`).catch(() => undefined);
    await adminDatabase.end().catch(() => undefined);
  }
}
