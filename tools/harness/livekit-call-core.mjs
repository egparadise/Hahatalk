import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RoomServiceClient, TokenVerifier } from "livekit-server-sdk";
import { io } from "socket.io-client";
import { Client } from "pg";

const root = process.cwd();
const apiEntry = path.join(root, "apps", "api", "dist", "main.js");
const migrationsDirectory = path.join(root, "apps", "api", "migrations");
const livekitExecutable = path.join(
  process.env.LOCALAPPDATA ?? "",
  "HahaTalkDev",
  "LiveKit",
  "1.13.3",
  "livekit-server.exe"
);
const baseDatabaseUrl = process.env.DATABASE_URL
  ?? "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const databaseName = `hahatalk_calls_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_calls_session";
const apiKey = "devkey";
const apiSecret = "secret";
const hubId = "00000000-0000-4000-8000-000000000201";
const groupId = "00000000-0000-4000-8000-000000000202";
const directId = "00000000-0000-4000-8000-000000000203";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

async function availableUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
}

async function startLiveKit() {
  const signalPort = await availableTcpPort();
  const tcpPort = await availableTcpPort();
  const udpPort = await availableUdpPort();
  const logs = [];
  const child = spawn(livekitExecutable, [
    "--dev",
    "--bind", "127.0.0.1",
    "--node-ip", "127.0.0.1",
    "--port", String(signalPort),
    "--rtc.tcp_port", String(tcpPort),
    "--udp-port", String(udpPort)
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const serviceUrl = `http://127.0.0.1:${signalPort}`;
  const client = new RoomServiceClient(serviceUrl, apiKey, apiSecret, { failover: false, requestTimeout: 1 });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`LiveKit exited during startup.\n${logs.join("")}`);
    try {
      await client.listRooms();
      return { child, client, logs, serviceUrl };
    } catch {
      await delay(100);
    }
  }
  child.kill();
  throw new Error(`LiveKit did not become ready.\n${logs.join("")}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000).then(() => child.exitCode === null && child.kill())
  ]);
}

async function startApi(port, webOrigin, livekitUrl) {
  const logs = [];
  const child = spawn(process.execPath, [apiEntry], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HAHATALK_ALLOW_OPEN_SIGNUP: "true",
      HAHATALK_MIGRATIONS_DIR: migrationsDirectory,
      LIVEKIT_API_KEY: apiKey,
      LIVEKIT_API_SECRET: apiSecret,
      LIVEKIT_URL: livekitUrl,
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
    if (child.exitCode !== null) throw new Error(`Calls API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // The fresh database is still migrating.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Calls API did not become healthy.\n${logs.join("")}`);
}

async function request(baseUrl, pathName, { cookie, method = "GET", origin, payload } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-HahaTalk-Client"] = "web-v1";
  }
  const response = await fetch(`${baseUrl}${pathName}`, {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers,
    method,
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { body, response };
}

function responseCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie, "Authentication response did not set a cookie.");
  return setCookie.split(";", 1)[0];
}

async function signup(baseUrl, webOrigin, email, password, displayName, characterId) {
  const result = await request(baseUrl, "/auth/signup", {
    method: "POST",
    origin: webOrigin,
    payload: { characterId, displayName, email, password }
  });
  assert(result.response.status === 201, `Signup failed for ${email}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return { cookie: responseCookie(result.response), userId: result.body.user.id };
}

async function post(baseUrl, webOrigin, cookie, pathName, payload = {}, expected = 200) {
  const result = await request(baseUrl, pathName, { cookie, method: "POST", origin: webOrigin, payload });
  assert(result.response.status === expected, `${pathName} expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function startCall(baseUrl, webOrigin, cookie, input, expected = 201) {
  return post(baseUrl, webOrigin, cookie, "/calls", input, expected);
}

async function connectSocket(baseUrl, cookie, spaceId) {
  const socket = io(baseUrl, {
    extraHeaders: { Cookie: cookie },
    transports: ["websocket"]
  });
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    }),
    delay(5_000).then(() => { throw new Error("Realtime socket did not connect."); })
  ]);
  socket.emit("room:join", { spaceId });
  return socket;
}

function nextEvent(socket, eventName) {
  return Promise.race([
    new Promise((resolve) => socket.once(eventName, resolve)),
    delay(7_000).then(() => { throw new Error(`${eventName} was not delivered.`); })
  ]);
}

async function waitForRoomCount(roomClient, expected) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const rooms = await roomClient.listRooms();
    if (rooms.length === expected) return rooms;
    await delay(100);
  }
  throw new Error(`LiveKit room count did not become ${expected}.`);
}

const adminDatabase = new Client({ connectionString: adminUrl.toString() });
const database = new Client({ connectionString: databaseUrl });
let adminConnected = false;
let databaseConnected = false;
let api;
let livekit;
let minaSocket;

try {
  await adminDatabase.connect();
  adminConnected = true;
  await adminDatabase.query(`create database "${databaseName}"`);
  await database.connect();
  databaseConnected = true;

  livekit = await startLiveKit();
  const apiPort = await availableTcpPort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${await availableTcpPort()}`;
  api = await startApi(apiPort, webOrigin, livekit.serviceUrl);

  const owner = await signup(baseUrl, webOrigin, "you@inviz.co.kr", "Stage6B!OwnerPass", "Stage6B Owner", "char-calm-lead");
  const mina = await signup(baseUrl, webOrigin, "mina@inviz.co.kr", "Stage6B!MinaPass", "Stage6B Mina", "char-focus-maker");
  const jun = await signup(baseUrl, webOrigin, "jun@inviz.co.kr", "Stage6B!JunPass", "Stage6B Jun", "char-calm-lead");
  const hana = await signup(baseUrl, webOrigin, "hana.customer@example.com", "Stage6B!HanaPass", "Stage6B Hana", "char-customer-guest");

  const capabilities = await request(baseUrl, "/calls/capabilities", { cookie: owner.cookie });
  assert(capabilities.response.status === 200 && capabilities.body.available && capabilities.body.deployment === "local", "Configured local call capability was not reported.");
  assert(!JSON.stringify(capabilities.body).includes(apiKey) && !JSON.stringify(capabilities.body).includes(apiSecret), "Capability response exposed provider credentials.");

  minaSocket = await connectSocket(baseUrl, mina.cookie, directId);
  const incomingEvent = nextEvent(minaSocket, "call:incoming");
  const directInput = {
    callType: "video",
    clientCallId: `call-direct-${randomUUID()}`,
    spaceId: directId,
    targetUserIds: [mina.userId]
  };
  const direct = await startCall(baseUrl, webOrigin, owner.cookie, directInput);
  assert(direct.status === "ringing" && direct.participants.length === 2 && direct.isCreator, "Direct call did not enter ringing state.");
  assert(!JSON.stringify(direct).includes("provider_room") && !JSON.stringify(direct).includes(apiSecret), "Ordinary call projection exposed provider internals.");
  const realtimeIncoming = await incomingEvent;
  assert(realtimeIncoming.id === direct.id && realtimeIncoming.isIncoming, "Incoming call realtime projection was incorrect.");

  const replay = await startCall(baseUrl, webOrigin, owner.cookie, directInput);
  assert(replay.id === direct.id, "Call idempotency replay created a second call.");
  await startCall(baseUrl, webOrigin, owner.cookie, { ...directInput, callType: "voice" }, 409);
  const unauthorized = await request(baseUrl, `/calls/${direct.id}`, { cookie: jun.cookie });
  assert(unauthorized.response.status === 404, "Non-participant could inspect a direct call.");

  const directDatabase = await database.query("select provider_room_name from call_sessions where id = $1", [direct.id]);
  const directRoomName = directDatabase.rows[0].provider_room_name;
  const rooms = await waitForRoomCount(livekit.client, 1);
  assert(rooms[0]?.name === directRoomName && rooms[0]?.maxParticipants === 2, "Provider room did not match the exact direct snapshot.");

  const ownerJoin = await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/join`);
  assert(ownerJoin.serverUrl === livekit.serviceUrl.replace("http:", "ws:") && ownerJoin.token && ownerJoin.call.status === "ringing", "Owner join credential was incomplete.");
  const claims = await new TokenVerifier(apiKey, apiSecret).verify(ownerJoin.token);
  assert(claims.sub !== owner.userId && claims.video?.room === directRoomName, "Join token used a stable app identity or wrong room.");
  assert(claims.video?.roomJoin === true && claims.video?.canSubscribe === true && claims.video?.canPublishData === false, "Join token grants were not least privilege.");
  assert(JSON.stringify(claims.video?.canPublishSources).includes("microphone") && JSON.stringify(claims.video?.canPublishSources).includes("camera"), "Video token did not limit sources to microphone and camera.");
  assert(!JSON.stringify(claims.video?.canPublishSources).includes("screen_share"), "Initial call token granted screen sharing before explicit consent.");
  assert(!claims.video?.roomAdmin && !claims.video?.roomRecord && !claims.video?.roomCreate, "Join token granted moderation, recording, or room creation.");
  const ownerConnected = await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/connected`);
  assert(ownerConnected.status === "active" && ownerConnected.participants.find((item) => item.isSelf)?.status === "joined", "Owner connection was not confirmed.");
  const minaJoin = await post(baseUrl, webOrigin, mina.cookie, `/calls/${direct.id}/join`);
  const minaClaims = await new TokenVerifier(apiKey, apiSecret).verify(minaJoin.token);
  assert(minaClaims.sub !== claims.sub, "Two users received the same provider identity.");
  const minaConnected = await post(baseUrl, webOrigin, mina.cookie, `/calls/${direct.id}/connected`);
  assert(minaConnected.status === "active" && minaConnected.participants.every((item) => item.status === "joined"), "Two-party app presence did not become active.");
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/screen-share/active`, {}, 409);
  const missingProviderShare = await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/screen-share/start`, {}, 503);
  assert(String(missingProviderShare.message).includes("Screen sharing permission"), "Missing provider participant did not roll back screen sharing safely.");
  const rolledBackShare = await request(baseUrl, `/calls/${direct.id}`, { cookie: owner.cookie });
  assert(
    rolledBackShare.body.participants.find((participant) => participant.isSelf)?.screenShareStatus === "off",
    "Provider grant failure left the call screen share locked."
  );
  const ownerInternal = await database.query("select id from users where public_id = $1", [owner.userId]);
  await database.query(
    `update call_participants set screen_share_status = 'starting', screen_share_requested_at = now()
     where call_session_id = $1 and user_id = $2`,
    [direct.id, ownerInternal.rows[0].id]
  );
  await post(baseUrl, webOrigin, mina.cookie, `/calls/${direct.id}/screen-share/start`, {}, 409);
  let uniqueShareRejected = false;
  try {
    await database.query(
      `update call_participants cp set screen_share_status = 'starting', screen_share_requested_at = now()
       from users u where cp.user_id = u.id and cp.call_session_id = $1 and u.public_id = $2`,
      [direct.id, mina.userId]
    );
  } catch (error) {
    uniqueShareRejected = error?.code === "23505";
  }
  assert(uniqueShareRejected, "Database did not enforce one active screen share per call session.");
  await database.query(
    `update call_participants set screen_share_status = 'off', screen_share_ended_at = now()
     where call_session_id = $1`,
    [direct.id]
  );

  minaSocket.close();
  minaSocket = undefined;
  await stopChild(api.child);
  api = await startApi(apiPort, webOrigin, livekit.serviceUrl);
  const afterRestart = await request(baseUrl, `/calls/${direct.id}`, { cookie: owner.cookie });
  assert(afterRestart.response.status === 200 && afterRestart.body.status === "active", "Active call did not survive API restart.");
  const endedDirect = await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/end`);
  assert(endedDirect.status === "ended" && endedDirect.endReason === "host_ended", "Host did not end the direct call.");
  await waitForRoomCount(livekit.client, 0);

  const hubInput = {
    callType: "voice",
    clientCallId: `call-hub-${randomUUID()}`,
    spaceId: hubId,
    targetUserIds: [mina.userId]
  };
  const hub = await startCall(baseUrl, webOrigin, owner.cookie, hubInput);
  const minaHub = await request(baseUrl, `/calls/${hub.id}`, { cookie: mina.cookie });
  const minaHubJson = JSON.stringify(minaHub.body);
  assert(minaHub.response.status === 200 && minaHub.body.participants.length === 2, "Hub spoke did not receive a direct two-person call projection.");
  assert(!minaHubJson.includes(jun.userId) && !minaHubJson.includes(hana.userId) && !minaHubJson.includes("프로젝트 A 허브방"), "Hub call leaked another spoke or hub identity.");
  await startCall(baseUrl, webOrigin, owner.cookie, {
    ...hubInput,
    clientCallId: `call-hub-multi-${randomUUID()}`,
    targetUserIds: [mina.userId, jun.userId]
  }, 400);
  await startCall(baseUrl, webOrigin, mina.cookie, {
    ...hubInput,
    clientCallId: `call-hub-forged-${randomUUID()}`,
    targetUserIds: [jun.userId]
  }, 400);
  const declinedHub = await post(baseUrl, webOrigin, mina.cookie, `/calls/${hub.id}/decline`);
  assert(declinedHub.status === "ended" && declinedHub.endReason === "no_participants", "Last hub participant decline did not end the call.");
  const repeatedDecline = await post(baseUrl, webOrigin, mina.cookie, `/calls/${hub.id}/decline`);
  assert(repeatedDecline.status === "ended", "Repeated decline was not retry-safe.");

  const group = await startCall(baseUrl, webOrigin, owner.cookie, {
    callType: "voice",
    clientCallId: `call-group-${randomUUID()}`,
    spaceId: groupId,
    targetUserIds: []
  });
  assert(group.participants.length === 3 && group.participants.some((item) => item.person.id === jun.userId), "Open group call did not snapshot all active group members.");
  const junJoin = await post(baseUrl, webOrigin, jun.cookie, `/calls/${group.id}/join`);
  const junClaims = await new TokenVerifier(apiKey, apiSecret).verify(junJoin.token);
  assert(JSON.stringify(junClaims.video?.canPublishSources) === JSON.stringify(["microphone"]), "Voice token allowed a non-microphone source.");
  await post(baseUrl, webOrigin, jun.cookie, `/calls/${group.id}/connected`);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${group.id}/end`);

  await startCall(baseUrl, webOrigin, hana.cookie, {
    callType: "voice",
    clientCallId: `call-guest-start-${randomUUID()}`,
    spaceId: hubId,
    targetUserIds: [owner.userId]
  }, 403);
  const guestCall = await startCall(baseUrl, webOrigin, owner.cookie, {
    callType: "voice",
    clientCallId: `call-guest-join-${randomUUID()}`,
    spaceId: hubId,
    targetUserIds: [hana.userId]
  });
  const guestJoin = await post(baseUrl, webOrigin, hana.cookie, `/calls/${guestCall.id}/join`);
  assert(guestJoin.call.participants.length === 2 && guestJoin.token, "Invited guest could not request a scoped join credential.");
  const junGuestPeek = await request(baseUrl, `/calls/${guestCall.id}`, { cookie: jun.cookie });
  assert(junGuestPeek.response.status === 404, "Uninvited hub spoke inspected a guest call.");
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${guestCall.id}/end`);

  await stopChild(livekit.child);
  const unavailable = await startCall(baseUrl, webOrigin, owner.cookie, {
    callType: "voice",
    clientCallId: `call-provider-down-${randomUUID()}`,
    spaceId: directId,
    targetUserIds: [mina.userId]
  }, 503);
  assert(String(unavailable.message).includes("call service"), "Provider failure did not return a bounded retry message.");

  const migration = await database.query("select checksum from schema_migrations where version = '007_livekit_call_core.sql'");
  assert(migration.rowCount === 1 && /^[0-9a-f]{64}$/.test(migration.rows[0].checksum), "Migration 007 checksum evidence is missing.");
  const screenMigration = await database.query("select checksum from schema_migrations where version = '009_screen_share_device_background.sql'");
  assert(screenMigration.rowCount === 1 && /^[0-9a-f]{64}$/.test(screenMigration.rows[0].checksum), "Migration 009 checksum evidence is missing.");
  const tables = await database.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name in ('call_sessions', 'call_participants', 'call_events')`
  );
  assert(tables.rowCount === 3, "Call migration did not create all three Stage 6B tables.");
  const audit = await database.query(
    `select action, metadata_json::text as metadata from audit_logs
     where target_type = 'call_session' order by created_at`
  );
  for (const action of ["call.start_requested", "call.ringing", "call.participant_connecting", "call.participant_joined", "call.screen_share_requested", "call.screen_share_provider_grant_failed", "call.ended", "call.provider_start_failed"]) {
    assert(audit.rows.some((row) => row.action === action), `Call audit action is missing: ${action}`);
  }
  const outbox = await database.query("select payload_json::text as payload from outbox_events where aggregate_type = 'call'");
  const durableText = JSON.stringify({ audit: audit.rows, outbox: outbox.rows });
  assert(!durableText.includes(apiSecret) && !durableText.includes("eyJ") && !durableText.includes(directRoomName), "Durable audit/outbox data exposed a secret, token, or provider room name.");

  console.log("LiveKit call integration passed: provider rooms, scoped tokens, screen-share grant rollback and singleton, direct/group/hub privacy, guest boundary, realtime, restart, failure, and audit verified.");
} finally {
  minaSocket?.close();
  await stopChild(api?.child).catch(() => undefined);
  await stopChild(livekit?.child).catch(() => undefined);
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
