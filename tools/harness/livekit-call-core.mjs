import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AccessToken, RoomServiceClient, TokenVerifier } from "livekit-server-sdk";
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

async function startApi(port, webOrigin, livekitUrl, extraEnv = {}) {
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
      HAHATALK_TEST_EGRESS_DRIVER: "memory",
      NODE_ENV: "test",
      PORT: String(port),
      SESSION_COOKIE_NAME: cookieName,
      WEB_ORIGIN: webOrigin,
      ...extraEnv
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

async function webhookAuthorization(body) {
  const token = new AccessToken(apiKey, apiSecret);
  token.sha256 = createHash("sha256").update(body).digest("base64");
  return token.toJwt();
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
  assert(
    capabilities.body.recording?.available === true
      && capabilities.body.recording.policyVersion === "hahatalk-recording-v1"
      && capabilities.body.recording.outputFormat === "mp4",
    "Configured recording capability was not reported."
  );
  assert(!JSON.stringify(capabilities.body).includes(apiKey) && !JSON.stringify(capabilities.body).includes(apiSecret), "Capability response exposed provider credentials.");
  const webhookBody = JSON.stringify({ event: "room_started" });
  const webhookToken = await webhookAuthorization(webhookBody);
  const wrongWebhookType = await fetch(`${baseUrl}/provider/livekit/webhook`, {
    body: webhookBody,
    headers: { Authorization: webhookToken, "Content-Type": "application/json" },
    method: "POST"
  });
  assert(wrongWebhookType.status === 403, "A signed webhook bypassed origin policy without the dedicated content type.");
  const invalidWebhook = await fetch(`${baseUrl}/provider/livekit/webhook`, {
    body: webhookBody,
    headers: { Authorization: "invalid", "Content-Type": "application/webhook+json" },
    method: "POST"
  });
  assert(invalidWebhook.status === 401, "An invalid LiveKit webhook signature was accepted.");
  const validWebhook = await fetch(`${baseUrl}/provider/livekit/webhook`, {
    body: webhookBody,
    headers: { Authorization: webhookToken, "Content-Type": "application/webhook+json" },
    method: "POST"
  });
  assert(validWebhook.status === 204, "A valid LiveKit webhook signature was rejected.");

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

  await post(baseUrl, webOrigin, mina.cookie, `/calls/${direct.id}/recording/request`, {}, 403);
  const recordingRealtime = nextEvent(minaSocket, "call:recording-updated");
  const deniedRequest = await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/recording/request`);
  assert(
    deniedRequest.status === "consent_pending"
      && deniedRequest.participants.length === 2
      && deniedRequest.participants.every((participant) => participant.consentStatus === "pending"),
    "Recording request did not capture the exact connected participant snapshot."
  );
  const recordingRealtimePayload = await recordingRealtime;
  assert(
    recordingRealtimePayload.sessionId === direct.id
      && Object.keys(recordingRealtimePayload).length === 1,
    "Recording realtime notification exposed more than the session identifier."
  );
  assert(
    !JSON.stringify(deniedRequest).includes("provider_")
      && !JSON.stringify(deniedRequest).includes("recordings/"),
    "Recording projection exposed provider identity or storage location."
  );
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/recording/start`, {}, 409);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/recording/consent`, {}, 400);
  await post(
    baseUrl,
    webOrigin,
    owner.cookie,
    `/calls/${direct.id}/recording/consent`,
    { decision: "granted", policyVersion: "obsolete-recording-policy" },
    409
  );
  await post(
    baseUrl,
    webOrigin,
    owner.cookie,
    `/calls/${direct.id}/recording/consent`,
    { decision: "granted", policyVersion: "hahatalk-recording-v1" }
  );
  const deniedRecording = await post(
    baseUrl,
    webOrigin,
    mina.cookie,
    `/calls/${direct.id}/recording/consent`,
    { decision: "denied", policyVersion: "hahatalk-recording-v1" }
  );
  assert(deniedRecording.status === "consent_denied" && deniedRecording.myConsentStatus === "denied", "A recording denial did not close the consent cycle.");
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/recording/start`, {}, 409);

  const concurrentRequests = await Promise.all([
    request(baseUrl, `/calls/${direct.id}/recording/request`, { cookie: owner.cookie, method: "POST", origin: webOrigin, payload: {} }),
    request(baseUrl, `/calls/${direct.id}/recording/request`, { cookie: owner.cookie, method: "POST", origin: webOrigin, payload: {} })
  ]);
  assert(
    concurrentRequests.map((result) => result.response.status).sort().join(",") === "200,409",
    "Concurrent recording requests did not produce exactly one durable winner."
  );
  const approvedRequest = concurrentRequests.find((result) => result.response.status === 200).body;
  assert(approvedRequest.id !== deniedRequest.id, "A denied recording cycle was incorrectly reused.");
  await post(
    baseUrl,
    webOrigin,
    owner.cookie,
    `/calls/${direct.id}/recording/consent`,
    { decision: "granted", policyVersion: "hahatalk-recording-v1" }
  );
  const allGranted = await post(
    baseUrl,
    webOrigin,
    mina.cookie,
    `/calls/${direct.id}/recording/consent`,
    { decision: "granted", policyVersion: "hahatalk-recording-v1" }
  );
  assert(allGranted.status === "consent_granted" && allGranted.allConsented && allGranted.canStart === false, "Participant consent did not produce a host-controlled start state.");
  await post(baseUrl, webOrigin, mina.cookie, `/calls/${direct.id}/recording/start`, {}, 403);
  const activeRecording = await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/recording/start`);
  assert(activeRecording.status === "recording" && activeRecording.canRevoke, "All-party consent did not start recording.");
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/recording/request`, {}, 409);
  const providerBeforeRecovery = await database.query(
    "select provider_egress_id from call_recordings where id = $1",
    [activeRecording.id]
  );
  const expectedProviderId = providerBeforeRecovery.rows[0].provider_egress_id;
  assert(expectedProviderId, "Active recording did not persist its provider identity privately.");
  await database.query(
    `update call_recordings set provider_egress_id = null, provider_status = 'starting',
       status = 'starting', provider_recovery_checked_at = null, updated_at = now()
     where id = $1`,
    [activeRecording.id]
  );
  let providerRecovered = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const row = await database.query(
      "select provider_egress_id, status from call_recordings where id = $1",
      [activeRecording.id]
    );
    if (row.rows[0].provider_egress_id === expectedProviderId && row.rows[0].status === "recording") {
      providerRecovered = true;
      break;
    }
    await delay(125);
  }
  assert(providerRecovered, "Reconciliation did not recover an Egress start response lost before database binding.");
  const providerStateEvents = await database.query(
    "select count(*)::int as count from call_events where call_session_id = $1 and event_type = 'recording.provider_state'",
    [direct.id]
  );
  await delay(5_500);
  const providerStateEventsAfterPoll = await database.query(
    "select count(*)::int as count from call_events where call_session_id = $1 and event_type = 'recording.provider_state'",
    [direct.id]
  );
  assert(
    providerStateEventsAfterPoll.rows[0].count === providerStateEvents.rows[0].count,
    "Unchanged provider reconciliation multiplied durable recording events."
  );
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${direct.id}/recording/stop`, {}, 400);
  const completedRecording = await post(
    baseUrl,
    webOrigin,
    mina.cookie,
    `/calls/${direct.id}/recording/stop`,
    { reason: "consent_revoked" }
  );
  assert(
    completedRecording.status === "ready"
      && completedRecording.myConsentStatus === "revoked"
      && Boolean(completedRecording.endedAt),
    "Participant consent revocation did not stop and finalize recording."
  );
  const consentEvidence = await database.query(
    `select decision from consent_records
     where consent_type = 'recording' and scope_type = 'call_recording'
     order by created_at`
  );
  assert(
    consentEvidence.rows.filter((row) => row.decision === "granted").length === 3
      && consentEvidence.rows.some((row) => row.decision === "denied")
      && consentEvidence.rows.some((row) => row.decision === "revoked"),
    "Append-only recording consent evidence was incomplete."
  );
  const recordingRows = await database.query(
    `select status, provider_egress_id, output_object_key, consent_snapshot_json
     from call_recordings where call_session_id = $1 order by requested_at`,
    [direct.id]
  );
  assert(
    recordingRows.rowCount === 2
      && recordingRows.rows[0].status === "consent_denied"
      && recordingRows.rows[1].status === "ready"
      && recordingRows.rows[1].provider_egress_id
      && recordingRows.rows[1].output_object_key.endsWith(".mp4")
      && recordingRows.rows[1].consent_snapshot_json.participants.length === 2,
    "Recording lifecycle or immutable consent snapshot was not persisted."
  );

  minaSocket.close();
  minaSocket = undefined;
  await stopChild(api.child);
  api = await startApi(apiPort, webOrigin, livekit.serviceUrl);
  const afterRestart = await request(baseUrl, `/calls/${direct.id}`, { cookie: owner.cookie });
  assert(
    afterRestart.response.status === 200
      && afterRestart.body.status === "active"
      && afterRestart.body.recording?.status === "ready",
    "Active call and completed recording did not survive API restart."
  );
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
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${group.id}/join`);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${group.id}/connected`);
  const junJoin = await post(baseUrl, webOrigin, jun.cookie, `/calls/${group.id}/join`);
  const junClaims = await new TokenVerifier(apiKey, apiSecret).verify(junJoin.token);
  assert(JSON.stringify(junClaims.video?.canPublishSources) === JSON.stringify(["microphone"]), "Voice token allowed a non-microphone source.");
  await post(baseUrl, webOrigin, jun.cookie, `/calls/${group.id}/connected`);
  const groupRecording = await post(baseUrl, webOrigin, owner.cookie, `/calls/${group.id}/recording/request`);
  assert(groupRecording.participants.length === 2, "Group recording included a member who had not joined the call.");
  await post(baseUrl, webOrigin, mina.cookie, `/calls/${group.id}/join`, {}, 409);
  const abortedGroupRecording = await post(
    baseUrl,
    webOrigin,
    owner.cookie,
    `/calls/${group.id}/recording/stop`,
    { reason: "host_stopped" }
  );
  assert(abortedGroupRecording.status === "aborted", "Host could not cancel a pending recording consent cycle.");
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

  await stopChild(api.child);
  api = await startApi(apiPort, webOrigin, livekit.serviceUrl, { HAHATALK_TEST_EGRESS_FAIL_START: "1" });
  const failedStartCall = await startCall(baseUrl, webOrigin, owner.cookie, {
    callType: "voice",
    clientCallId: `call-recording-start-failure-${randomUUID()}`,
    spaceId: directId,
    targetUserIds: [mina.userId]
  });
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${failedStartCall.id}/join`);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${failedStartCall.id}/connected`);
  await post(baseUrl, webOrigin, mina.cookie, `/calls/${failedStartCall.id}/join`);
  await post(baseUrl, webOrigin, mina.cookie, `/calls/${failedStartCall.id}/connected`);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${failedStartCall.id}/recording/request`);
  for (const participant of [owner, mina]) {
    await post(
      baseUrl,
      webOrigin,
      participant.cookie,
      `/calls/${failedStartCall.id}/recording/consent`,
      { decision: "granted", policyVersion: "hahatalk-recording-v1" }
    );
  }
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${failedStartCall.id}/recording/start`, {}, 503);
  const failedStartView = await request(baseUrl, `/calls/${failedStartCall.id}`, { cookie: owner.cookie });
  assert(
    failedStartView.body.status === "active"
      && failedStartView.body.recording?.status === "failed"
      && failedStartView.body.recording.failureCode === "provider_start_failed",
    "Egress start failure did not remain isolated from the active media session."
  );
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${failedStartCall.id}/end`);
  await waitForRoomCount(livekit.client, 0);

  await stopChild(api.child);
  api = await startApi(apiPort, webOrigin, livekit.serviceUrl, { HAHATALK_TEST_EGRESS_FAIL_STOP: "1" });
  const failClosedCall = await startCall(baseUrl, webOrigin, owner.cookie, {
    callType: "voice",
    clientCallId: `call-recording-fail-closed-${randomUUID()}`,
    spaceId: directId,
    targetUserIds: [mina.userId]
  });
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${failClosedCall.id}/join`);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${failClosedCall.id}/connected`);
  await post(baseUrl, webOrigin, mina.cookie, `/calls/${failClosedCall.id}/join`);
  await post(baseUrl, webOrigin, mina.cookie, `/calls/${failClosedCall.id}/connected`);
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${failClosedCall.id}/recording/request`);
  await post(
    baseUrl,
    webOrigin,
    owner.cookie,
    `/calls/${failClosedCall.id}/recording/consent`,
    { decision: "granted", policyVersion: "hahatalk-recording-v1" }
  );
  await post(
    baseUrl,
    webOrigin,
    mina.cookie,
    `/calls/${failClosedCall.id}/recording/consent`,
    { decision: "granted", policyVersion: "hahatalk-recording-v1" }
  );
  await post(baseUrl, webOrigin, owner.cookie, `/calls/${failClosedCall.id}/recording/start`);
  const uncertainStop = await post(
    baseUrl,
    webOrigin,
    mina.cookie,
    `/calls/${failClosedCall.id}/recording/stop`,
    { reason: "consent_revoked" },
    503
  );
  assert(String(uncertainStop.message).includes("media session was ended"), "Uncertain recording stop did not report fail-closed shutdown.");
  const failedSession = await request(baseUrl, `/calls/${failClosedCall.id}`, { cookie: owner.cookie });
  assert(
    failedSession.body.status === "failed"
      && failedSession.body.endReason === "recording_stop_uncertain"
      && failedSession.body.recording?.status === "failed"
      && failedSession.body.recording.failureCode === "provider_stop_uncertain",
    "Uncertain recording stop did not fail closed at both recording and session levels."
  );
  await waitForRoomCount(livekit.client, 0);

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
  const recordingMigration = await database.query("select checksum from schema_migrations where version = '010_recording_consent_egress.sql'");
  assert(recordingMigration.rowCount === 1 && /^[0-9a-f]{64}$/.test(recordingMigration.rows[0].checksum), "Migration 010 checksum evidence is missing.");
  const tables = await database.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name in ('call_sessions', 'call_participants', 'call_events')`
  );
  assert(tables.rowCount === 3, "Call migration did not create all three Stage 6B tables.");
  const recordingTables = await database.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name in ('call_recordings', 'call_recording_participants')`
  );
  assert(recordingTables.rowCount === 2, "Recording migration did not create the lifecycle and participant snapshot tables.");
  const audit = await database.query(
    `select action, metadata_json::text as metadata from audit_logs
     where target_type = 'call_session' order by created_at`
  );
  for (const action of ["call.start_requested", "call.ringing", "call.participant_connecting", "call.participant_joined", "call.screen_share_requested", "call.screen_share_provider_grant_failed", "call.ended", "call.provider_start_failed"]) {
    assert(audit.rows.some((row) => row.action === action), `Call audit action is missing: ${action}`);
  }
  const recordingAudit = await database.query(
    `select action, metadata_json::text as metadata from audit_logs
     where target_type = 'call_recording' order by created_at`
  );
  for (const action of ["recording.consent_requested", "recording.consent_granted", "recording.consent_denied", "recording.start_requested", "recording.provider_state", "recording.provider_start_failed", "recording.consent_revoked", "recording.fail_closed"]) {
    assert(recordingAudit.rows.some((row) => row.action === action), `Recording audit action is missing: ${action}`);
  }
  const outbox = await database.query("select payload_json::text as payload from outbox_events where aggregate_type = 'call'");
  const durableText = JSON.stringify({ audit: audit.rows, outbox: outbox.rows, recordingAudit: recordingAudit.rows });
  assert(!durableText.includes(apiSecret) && !durableText.includes("eyJ") && !durableText.includes(directRoomName), "Durable audit/outbox data exposed a secret, token, or provider room name.");

  console.log("LiveKit call integration passed: provider rooms, scoped tokens, screen sharing, unanimous recording consent, revoke/fail-closed behavior, direct/group/hub privacy, guest boundary, realtime, restart, failure, and audit verified.");
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
