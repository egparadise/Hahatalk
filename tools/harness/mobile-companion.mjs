import { randomBytes, randomUUID } from "node:crypto";
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
const databaseName = `hahatalk_mobile_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_mobile_harness";
const mobileKey = randomBytes(32).toString("base64");
const mobileWorkerToken = `hht_mobile_worker_${randomBytes(32).toString("base64url")}`;
const hubId = "00000000-0000-4000-8000-000000000201";
const users = {
  jun: { internalId: "00000000-0000-4000-8000-000000000103", publicId: "user-jun" },
  mina: { internalId: "00000000-0000-4000-8000-000000000102", publicId: "user-mina" },
  owner: { internalId: "00000000-0000-4000-8000-000000000101", publicId: "user-you" }
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
      MOBILE_PUSH_TOKEN_KEY: mobileKey,
      MOBILE_PUSH_TOKEN_KEY_ID: "stage10-test-key",
      MOBILE_PUSH_WORKER_TOKEN: mobileWorkerToken,
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
    if (child.exitCode !== null) throw new Error(`Mobile API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // Fresh Windows migrations can take several seconds.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Mobile API did not become healthy.\n${logs.join("")}`);
}

async function stopApi(api) {
  if (!api?.child || api.child.exitCode !== null) return;
  api.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => api.child.once("exit", resolve)),
    delay(5_000).then(() => api.child.exitCode === null && api.child.kill())
  ]);
}

async function request(baseUrl, pathName, { accessToken, cookie, headers = {}, method = "GET", origin, payload } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  if (origin) requestHeaders.Origin = origin;
  if (accessToken) requestHeaders.Authorization = `Bearer ${accessToken}`;
  let body;
  if (payload !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  const response = await fetch(`${baseUrl}${pathName}`, {
    body,
    headers: requestHeaders,
    method,
    signal: AbortSignal.timeout(30_000)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const responseBody = contentType.includes("application/json") ? await response.json() : await response.text();
  return { body: responseBody, response };
}

async function expectStatus(baseUrl, pathName, options, expected) {
  const result = await request(baseUrl, pathName, options);
  assert(
    result.response.status === expected,
    `${options.method ?? "GET"} ${pathName} expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`
  );
  return result.body;
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  assert(value, "Web signup did not set a session cookie.");
  return value.split(";", 1)[0];
}

async function signup(baseUrl, origin, email, password, displayName, characterId) {
  const result = await request(baseUrl, "/auth/signup", {
    headers: { "X-HahaTalk-Client": "web-v1" },
    method: "POST",
    origin,
    payload: { characterId, displayName, email, password }
  });
  assert(result.response.status === 201, `Signup failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  return { cookie: cookieFrom(result.response), state: result.body };
}

async function mobilePost(baseUrl, pathName, payload, expected = 201, accessToken, extraHeaders = {}) {
  return expectStatus(baseUrl, pathName, {
    accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1", ...extraHeaders },
    method: "POST",
    payload
  }, expected);
}

async function mobileLogin(baseUrl, email, password, installationId, platform = "android") {
  return mobilePost(baseUrl, "/auth/mobile/login", {
    appVersion: "0.17.0-test",
    email,
    installationId,
    password,
    platform
  });
}

async function socketBearerCheck(baseUrl, accessToken) {
  await new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      auth: { accessToken },
      forceNew: true,
      reconnection: false,
      transports: ["websocket"]
    });
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Mobile Socket.IO bearer authentication timed out."));
    }, 8_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.close();
      resolve();
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

  const owner = await signup(baseUrl, origin, "you@inviz.co.kr", "Stage10!OwnerPass", "Stage10 Owner", "char-calm-lead");
  const mina = await signup(baseUrl, origin, "mina@inviz.co.kr", "Stage10!MinaPass", "Stage10 Mina", "char-focus-maker");
  await signup(baseUrl, origin, "jun@inviz.co.kr", "Stage10!JunPass", "Stage10 Jun", "char-calm-lead");
  assert(owner.state.user.id === users.owner.publicId && mina.state.user.id === users.mina.publicId, "Seed identities changed.");

  const ownerInstallation = randomUUID();
  await expectStatus(baseUrl, "/auth/mobile/login", {
    headers: { "X-HahaTalk-Client": "mobile-v1" },
    method: "POST",
    origin: "https://malicious.example",
    payload: {
      appVersion: "0.17.0-test",
      email: "you@inviz.co.kr",
      installationId: ownerInstallation,
      password: "Stage10!OwnerPass",
      platform: "android"
    }
  }, 403);
  await expectStatus(baseUrl, "/auth/mobile/login", {
    method: "POST",
    payload: {
      appVersion: "0.17.0-test",
      email: "you@inviz.co.kr",
      installationId: ownerInstallation,
      password: "Stage10!OwnerPass",
      platform: "android"
    }
  }, 403);

  const ownerMobile = await mobileLogin(baseUrl, "you@inviz.co.kr", "Stage10!OwnerPass", ownerInstallation);
  assert(ownerMobile.accessToken.startsWith("hha_") && ownerMobile.refreshToken.startsWith("hhr_"), "Mobile token format is invalid.");
  const storedTokens = await database.query(
    `select octet_length(access_token_hash) as access_digest,
            (select octet_length(token_hash) from mobile_refresh_tokens where session_id = ms.id and status = 'active') as refresh_digest
     from mobile_sessions ms where id = $1`,
    [await database.query("select id from mobile_sessions where user_id = $1 and revoked_at is null", [users.owner.internalId]).then((r) => r.rows[0].id)]
  );
  assert(Number(storedTokens.rows[0]?.access_digest) === 32 && Number(storedTokens.rows[0]?.refresh_digest) === 32, "Mobile token digests were not persisted correctly.");
  const me = await expectStatus(baseUrl, "/auth/me", {
    accessToken: ownerMobile.accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1" }
  }, 200);
  assert(me.user.id === users.owner.publicId, "Mobile bearer did not resolve the account.");
  await socketBearerCheck(baseUrl, ownerMobile.accessToken);

  await database.query(
    "update mobile_sessions set access_expires_at = created_at + interval '1 millisecond' where user_id = $1 and revoked_at is null",
    [users.owner.internalId]
  );
  await expectStatus(baseUrl, "/auth/me", {
    accessToken: ownerMobile.accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1" }
  }, 401);
  const ownerRefreshed = await mobilePost(baseUrl, "/auth/mobile/refresh", {
    appVersion: "0.17.0-test",
    installationId: ownerInstallation,
    platform: "android",
    refreshToken: ownerMobile.refreshToken
  });
  await expectStatus(baseUrl, "/auth/me", {
    accessToken: ownerMobile.accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1" }
  }, 401);
  await expectStatus(baseUrl, "/auth/me", {
    accessToken: ownerRefreshed.accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1" }
  }, 200);
  await mobilePost(baseUrl, "/auth/mobile/refresh", {
    appVersion: "0.17.0-test",
    installationId: ownerInstallation,
    platform: "android",
    refreshToken: ownerMobile.refreshToken
  }, 401);
  await expectStatus(baseUrl, "/auth/me", {
    accessToken: ownerRefreshed.accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1" }
  }, 401);

  const ownerMobile2 = await mobileLogin(baseUrl, "you@inviz.co.kr", "Stage10!OwnerPass", ownerInstallation);
  const minaInstallation = randomUUID();
  const minaMobile = await mobileLogin(baseUrl, "mina@inviz.co.kr", "Stage10!MinaPass", minaInstallation);
  const capabilities = await expectStatus(baseUrl, "/mobile/capabilities?platform=android", {
    accessToken: minaMobile.accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1" }
  }, 200);
  assert(capabilities.push.registrationAvailable && !capabilities.screenShare.available && !capabilities.remoteControl.available, "Mobile capability gate is inaccurate.");

  const expoPushToken = `ExpoPushToken[stage10_${randomBytes(18).toString("base64url")}]`;
  const device = await mobilePost(baseUrl, "/mobile/devices", {
    appVersion: "0.17.0-test",
    capabilities: { calls: true, notifications: true },
    installationId: minaInstallation,
    locale: "ko-KR",
    osVersion: "Android 16 test",
    platform: "android",
    pushProvider: "expo",
    pushToken: expoPushToken,
    timezone: "Asia/Seoul"
  }, 201, minaMobile.accessToken);
  assert(device.current && !JSON.stringify(device).includes(expoPushToken), "Device projection leaked a push token.");
  const encryptedToken = await database.query(
    `select octet_length(push_token_digest) as digest_length,
            push_token_ciphertext = convert_to($2, 'utf8') as plaintext_cipher,
            (select count(*)::text from audit_logs where metadata_json::text like '%' || $2 || '%') as audit_leaks
     from mobile_devices where id = $1`,
    [device.id, expoPushToken]
  );
  assert(
    Number(encryptedToken.rows[0]?.digest_length) === 32
      && encryptedToken.rows[0]?.plaintext_cipher === false
      && encryptedToken.rows[0]?.audit_leaks === "0",
    "Push token encryption or audit redaction failed."
  );

  const minaView = await expectStatus(baseUrl, `/spaces/${hubId}/view`, {
    accessToken: minaMobile.accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1" }
  }, 200);
  assert(
    minaView.room.mode === "direct"
      && minaView.users.every((user) => [users.owner.publicId, users.mina.publicId].includes(user.id))
      && !JSON.stringify(minaView).includes(users.jun.publicId),
    "Mobile hidden-hub projection exposed another spoke."
  );

  const privateMessageBody = "Stage 10 private mobile push body must stay server-side.";
  const sent = await expectStatus(baseUrl, "/messages", {
    cookie: owner.cookie,
    headers: { "X-HahaTalk-Client": "web-v1" },
    method: "POST",
    origin,
    payload: {
      audienceType: "private",
      body: privateMessageBody,
      clientMessageId: `stage10-owner-message-${randomUUID()}`,
      requiresConfirmation: false,
      spaceId: hubId,
      targetUserIds: [users.mina.publicId]
    }
  }, 201);
  const pushStorage = await database.query(
    `select title, body, route, payload_json::text,
            (payload_json::text like '%' || $2 || '%' or body like '%' || $2 || '%') as leaked
     from mobile_push_jobs where event_key = $1`,
    [`message:${sent.message.id}`, privateMessageBody]
  );
  assert(pushStorage.rowCount === 1 && pushStorage.rows[0].leaked === false, "Push job leaked private message content or was not queued once.");
  assert(pushStorage.rows[0].body === "\uC0C8 \uBA54\uC2DC\uC9C0\uAC00 \uB3C4\uCC29\uD588\uC2B5\uB2C8\uB2E4." && pushStorage.rows[0].route === `/space/${hubId}`, "Push job is not generic or viewer-safe.");

  const organizationId = await database.query(
    "select organization_id from conversation_spaces where id = $1",
    [hubId]
  ).then((result) => result.rows[0].organization_id);
  const incomingCallId = randomUUID();
  await database.query(
    `insert into call_sessions (
       id, organization_id, space_id, created_by, call_type, provider_room_name, status, expires_at
     ) values ($1, $2, $3, $4, 'voice', $5, 'ringing', now() + interval '90 seconds')`,
    [incomingCallId, organizationId, hubId, users.owner.internalId, `stage10_mobile_call_${randomUUID()}`]
  );
  await database.query(
    `insert into call_participants (call_session_id, user_id, role, status, provider_identity)
     values ($1, $2, 'host', 'invited', $4), ($1, $3, 'participant', 'invited', $5)`,
    [incomingCallId, users.owner.internalId, users.mina.internalId, `stage10_owner_${randomUUID()}`, `stage10_mina_${randomUUID()}`]
  );

  await expectStatus(baseUrl, "/internal/mobile/push/claim", {
    headers: { "X-HahaTalk-Mobile-Worker-Token": "invalid-worker-token-with-sufficient-length" },
    method: "POST",
    payload: { limit: 10, workerId: "stage10-worker" }
  }, 401);
  const claimed = await expectStatus(baseUrl, "/internal/mobile/push/claim", {
    headers: { "X-HahaTalk-Mobile-Worker-Token": mobileWorkerToken },
    method: "POST",
    payload: { limit: 10, workerId: "stage10-worker" }
  }, 200);
  const messagePush = claimed.find((job) => job.eventType === "conversation.message");
  const callPush = claimed.find((job) => job.eventType === "call.invite");
  assert(claimed.length === 2 && messagePush?.pushToken === expoPushToken, "Trusted worker could not decrypt the claimed push token.");
  assert(
    callPush?.body === "새 통화 요청이 있습니다."
      && callPush.route === `/call/${incomingCallId}`
      && !JSON.stringify(callPush).includes(owner.state.user.displayName),
    "Incoming call push was missing, unsafe, or not viewer-generic."
  );
  await expectStatus(baseUrl, `/internal/mobile/push/${callPush.id}/complete`, {
    headers: { "X-HahaTalk-Mobile-Worker-Token": mobileWorkerToken },
    method: "POST",
    payload: { outcome: "delivered", providerMessageId: "expo-call-stage10", workerId: "stage10-worker" }
  }, 200);
  const retry = await expectStatus(baseUrl, `/internal/mobile/push/${messagePush.id}/complete`, {
    headers: { "X-HahaTalk-Mobile-Worker-Token": mobileWorkerToken },
    method: "POST",
    payload: { errorCode: "provider_busy", outcome: "failed", retryable: true, workerId: "stage10-worker" }
  }, 200);
  assert(retry.status === "queued", "Retryable push failure did not return to the queue.");
  await database.query("update mobile_push_jobs set available_at = now() where id = $1", [messagePush.id]);
  const claimedAgain = await expectStatus(baseUrl, "/internal/mobile/push/claim", {
    headers: { "X-HahaTalk-Mobile-Worker-Token": mobileWorkerToken },
    method: "POST",
    payload: { limit: 10, workerId: "stage10-worker" }
  }, 200);
  assert(claimedAgain[0]?.attempt === 2, "Push retry attempt was not fenced and incremented.");
  await expectStatus(baseUrl, `/internal/mobile/push/${messagePush.id}/complete`, {
    headers: { "X-HahaTalk-Mobile-Worker-Token": mobileWorkerToken },
    method: "POST",
    payload: { outcome: "delivered", providerMessageId: "expo-receipt-stage10", workerId: "stage10-worker" }
  }, 200);

  const offlineMessageId = `stage10-offline-${randomUUID()}`;
  const offlinePayload = {
    audienceType: "private",
    body: "암호화된 오프라인 큐에서 재전송한 답장입니다.",
    clientMessageId: offlineMessageId,
    requiresConfirmation: false,
    spaceId: hubId,
    targetUserIds: [users.owner.publicId]
  };
  const firstOffline = await mobilePost(baseUrl, "/messages", offlinePayload, 201, minaMobile.accessToken);
  const replayOffline = await mobilePost(baseUrl, "/messages", offlinePayload, 201, minaMobile.accessToken);
  assert(firstOffline.message.id === replayOffline.message.id && replayOffline.replay, "Offline message replay was not idempotent.");
  const offlineRows = await database.query("select count(*)::text as count from messages where client_message_id = $1", [offlineMessageId]);
  assert(offlineRows.rows[0]?.count === "1", "Offline replay created a duplicate message.");

  await expectStatus(baseUrl, "/messages", {
    accessToken: minaMobile.accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1" },
    method: "POST",
    origin: "https://malicious.example",
    payload: { ...offlinePayload, clientMessageId: `spoof-${randomUUID()}` }
  }, 403);

  await mobilePost(baseUrl, "/auth/logout", {}, 201, minaMobile.accessToken);
  await expectStatus(baseUrl, "/auth/me", {
    accessToken: minaMobile.accessToken,
    headers: { "X-HahaTalk-Client": "mobile-v1" }
  }, 401);
  const revoked = await database.query(
    `select d.status, count(j.*)::text as pending
     from mobile_devices d
     left join mobile_push_jobs j on j.device_id = d.id and j.status in ('queued', 'claimed')
     where d.id = $1 group by d.status`,
    [device.id]
  );
  assert(revoked.rows[0]?.status === "revoked" && revoked.rows[0]?.pending === "0", "Mobile logout did not revoke the device and pending push jobs.");

  await mobilePost(baseUrl, "/auth/logout", {}, 201, ownerMobile2.accessToken);
  console.log("Mobile companion integration passed: native origin policy, bearer/refresh rotation and replay revoke, Socket.IO bearer, encrypted device tokens, generic message/call push lease-retry, hidden-hub projection, offline idempotency, and logout cleanup are verified.");
} catch (error) {
  await delay(250);
  if (api?.logs?.length) {
    const logTail = api.logs.join("").split(/\r?\n/).slice(-80).join("\n");
    console.error(logTail);
  }
  throw error;
} finally {
  await stopApi(api).catch(() => undefined);
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
