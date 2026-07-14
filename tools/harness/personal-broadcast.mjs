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
const databaseName = `hahatalk_broadcast_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_broadcast_session";
const apiKey = "devkey";
const apiSecret = "secret";
const defaultHubId = "00000000-0000-4000-8000-000000000201";

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
      HAHATALK_TEST_EGRESS_DRIVER: "memory",
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
    if (child.exitCode !== null) throw new Error(`Broadcast API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // Fresh migrations and the first Nest module load can take several seconds on Windows.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Broadcast API did not become healthy.\n${logs.join("")}`);
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

async function mutate(baseUrl, webOrigin, cookie, pathName, payload, method = "POST", expected = 200) {
  const result = await request(baseUrl, pathName, { cookie, method, origin: webOrigin, payload });
  assert(result.response.status === expected, `${method} ${pathName} expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function connectSocket(baseUrl, cookie) {
  const socket = io(baseUrl, { extraHeaders: { Cookie: cookie }, transports: ["websocket"] });
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    }),
    delay(5_000).then(() => { throw new Error("Broadcast realtime socket did not connect."); })
  ]);
  socket.emit("room:join", { spaceId: defaultHubId });
  await Promise.race([
    new Promise((resolve) => socket.once("room:snapshot", resolve)),
    delay(5_000).then(() => { throw new Error("Broadcast socket did not join its user channel."); })
  ]);
  return socket;
}

function nextEvent(socket, eventName, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`${eventName} was not delivered.`));
    }, 7_000);
    const onEvent = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(eventName, onEvent);
      resolve(payload);
    };
    socket.on(eventName, onEvent);
  });
}

async function waitForRoomCount(client, expected) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rooms = await client.listRooms();
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

  const owner = await signup(baseUrl, webOrigin, "you@inviz.co.kr", "Stage7!OwnerPass", "Stage7 Owner", "char-calm-lead");
  const mina = await signup(baseUrl, webOrigin, "mina@inviz.co.kr", "Stage7!MinaPass", "Stage7 Mina", "char-focus-maker");
  const jun = await signup(baseUrl, webOrigin, "jun@inviz.co.kr", "Stage7!JunPass", "Stage7 Jun", "char-calm-lead");
  const hana = await signup(baseUrl, webOrigin, "hana.customer@example.com", "Stage7!HanaPass", "Stage7 Hana", "char-customer-guest");

  const capabilities = await request(baseUrl, "/broadcasts/capabilities", { cookie: owner.cookie });
  assert(capabilities.response.status === 200 && capabilities.body.available, "Broadcast capability was not reported.");
  assert(!JSON.stringify(capabilities.body).includes(apiKey) && !JSON.stringify(capabilities.body).includes(apiSecret), "Broadcast capability exposed provider credentials.");

  const channel = await mutate(baseUrl, webOrigin, owner.cookie, "/broadcasts/channels", {
    description: "Stage 7 product briefing",
    handle: "stage7-live",
    name: "Stage 7 Live",
    visibility: "organization"
  }, "POST", 201);
  assert(channel.isOwner && channel.isSubscribed && channel.subscriberCount === 1, "Channel owner projection is incomplete.");
  await mutate(baseUrl, webOrigin, owner.cookie, "/broadcasts/channels", {
    description: "duplicate",
    handle: "stage7-live",
    name: "Duplicate",
    visibility: "organization"
  }, "POST", 409);
  await mutate(baseUrl, webOrigin, hana.cookie, "/broadcasts/channels", {
    handle: "guest-channel",
    name: "Guest Channel",
    visibility: "organization"
  }, "POST", 403);

  const unlisted = await mutate(baseUrl, webOrigin, owner.cookie, "/broadcasts/channels", {
    description: "Invite-only discovery",
    handle: "stage7-unlisted",
    name: "Stage 7 Unlisted",
    visibility: "unlisted"
  }, "POST", 201);
  const minaBeforeSubscribe = await request(baseUrl, "/broadcasts", { cookie: mina.cookie });
  assert(
    minaBeforeSubscribe.response.status === 200
      && minaBeforeSubscribe.body.channels.some((item) => item.id === channel.id)
      && !minaBeforeSubscribe.body.channels.some((item) => item.id === unlisted.id),
    "Unlisted channel discovery leaked before subscription."
  );
  await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/channels/${unlisted.id}/subscribe`, { notificationLevel: "off" });
  const minaAfterUnlistedSubscribe = await request(baseUrl, "/broadcasts", { cookie: mina.cookie });
  assert(minaAfterUnlistedSubscribe.body.channels.some((item) => item.id === unlisted.id), "Known unlisted channel did not appear after subscription.");
  await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/channels/${unlisted.id}/subscription`, {}, "DELETE");

  for (const actor of [mina, jun, hana]) {
    const subscribed = await mutate(baseUrl, webOrigin, actor.cookie, `/broadcasts/channels/${channel.id}/subscribe`, {
      notificationLevel: "live_only"
    });
    assert(subscribed.isSubscribed, "Channel subscription did not become active.");
  }
  minaSocket = await connectSocket(baseUrl, mina.cookie);

  const now = Date.now();
  const scheduleInput = {
    callType: "video",
    chatMode: "moderated",
    clientSessionId: `broadcast-${randomUUID()}`,
    description: "Privacy-first personal broadcast",
    expectedEndAt: new Date(now + 65 * 60_000).toISOString(),
    replayRequested: true,
    scheduledFor: new Date(now + 5 * 60_000).toISOString(),
    title: "Stage 7 Broadcast",
    viewerLimit: 20
  };
  const scheduledEvent = nextEvent(
    minaSocket,
    "broadcast:updated",
    (payload) => payload.channelId === channel.id && payload.reason === "scheduled"
  );
  const scheduled = await mutate(
    baseUrl,
    webOrigin,
    owner.cookie,
    `/broadcasts/channels/${channel.id}/sessions`,
    scheduleInput,
    "POST",
    201
  );
  assert(scheduled.status === "scheduled" && scheduled.myRole === "host" && scheduled.version === 1, "Broadcast schedule projection is incomplete.");
  assert(!JSON.stringify(scheduled).includes("hht_broadcast_") && !JSON.stringify(scheduled).includes(apiSecret), "Scheduled broadcast exposed provider internals.");
  const scheduledRealtime = await scheduledEvent;
  assert(Object.keys(scheduledRealtime).sort().join(",") === "channelId,reason,sessionId", "Broadcast realtime payload contains unexpected fields.");
  const scheduleReplay = await mutate(
    baseUrl,
    webOrigin,
    owner.cookie,
    `/broadcasts/channels/${channel.id}/sessions`,
    scheduleInput,
    "POST",
    201
  );
  assert(scheduleReplay.id === scheduled.id, "Broadcast schedule idempotency created a duplicate session.");
  await mutate(baseUrl, webOrigin, owner.cookie, `/broadcasts/channels/${channel.id}/sessions`, {
    ...scheduleInput,
    title: "Changed payload"
  }, "POST", 409);
  await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/channels/${channel.id}/sessions`, {
    ...scheduleInput,
    clientSessionId: `broadcast-denied-${randomUUID()}`
  }, "POST", 403);

  const liveEvent = nextEvent(
    minaSocket,
    "broadcast:updated",
    (payload) => payload.sessionId === scheduled.id && payload.reason === "live"
  );
  const live = await mutate(baseUrl, webOrigin, owner.cookie, `/broadcasts/sessions/${scheduled.id}/start`, {
    version: scheduled.version
  });
  assert(live.status === "live" && live.replay.status === "processing", "Broadcast did not enter live state.");
  await liveEvent;
  const roomRows = await database.query("select provider_room_name from call_sessions where id = $1", [scheduled.id]);
  const providerRoomName = roomRows.rows[0].provider_room_name;
  const rooms = await waitForRoomCount(livekit.client, 1);
  assert(rooms[0]?.name === providerRoomName && rooms[0]?.maxParticipants === 36, "LiveKit room did not use the bounded broadcast capacity.");

  const ownerJoin = await mutate(baseUrl, webOrigin, owner.cookie, `/broadcasts/sessions/${scheduled.id}/join`, {});
  const ownerClaims = await new TokenVerifier(apiKey, apiSecret).verify(ownerJoin.token);
  assert(ownerClaims.sub !== owner.userId && ownerClaims.video?.room === providerRoomName, "Host token exposed stable app identity or wrong room.");
  assert(ownerClaims.video?.canPublish === true && ownerClaims.video?.hidden !== true, "Host token did not receive visible stage publish permission.");
  assert(
    JSON.stringify(ownerClaims.video?.canPublishSources) === JSON.stringify(["microphone", "camera"]),
    "Host token was not limited to microphone and camera."
  );
  assert(!ownerClaims.video?.canPublishData && !ownerClaims.video?.roomAdmin && !ownerClaims.video?.roomRecord, "Host token received data, admin, or recording grants.");
  await mutate(baseUrl, webOrigin, owner.cookie, `/broadcasts/sessions/${scheduled.id}/connected`, {});

  const minaJoin = await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/sessions/${scheduled.id}/join`, {});
  const minaClaims = await new TokenVerifier(apiKey, apiSecret).verify(minaJoin.token);
  assert(
    minaClaims.video?.room === providerRoomName
      && minaClaims.video?.canSubscribe === true
      && minaClaims.video?.canPublish === false
      && minaClaims.video?.canPublishData === false
      && minaClaims.video?.hidden === true,
    "Viewer token was not hidden and subscribe-only."
  );
  assert(!minaClaims.video?.roomAdmin && !minaClaims.video?.roomRecord && !minaClaims.video?.roomCreate, "Viewer token received privileged grants.");
  await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/sessions/${scheduled.id}/connected`, {});

  const junJoin = await mutate(baseUrl, webOrigin, jun.cookie, `/broadcasts/sessions/${scheduled.id}/join`, {});
  const junClaims = await new TokenVerifier(apiKey, apiSecret).verify(junJoin.token);
  assert(junClaims.video?.hidden === true && junClaims.video?.canPublish === false, "Second viewer token was not hidden and subscribe-only.");
  await mutate(baseUrl, webOrigin, jun.cookie, `/broadcasts/sessions/${scheduled.id}/connected`, {});

  const minaView = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}`, { cookie: mina.cookie });
  const minaJson = JSON.stringify(minaView.body);
  assert(minaView.response.status === 200 && minaView.body.viewerCount === 2, "Viewer projection did not expose the aggregate live count.");
  assert(!Object.hasOwn(minaView.body, "moderationParticipants"), "Viewer received the moderation roster.");
  assert(!minaJson.includes(jun.userId) && !minaJson.includes("Stage7 Jun"), "Viewer A learned viewer B identity or name.");
  const ownerView = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}`, { cookie: owner.cookie });
  assert(ownerView.body.moderationParticipants.some((item) => item.person.id === jun.userId), "Host did not receive the moderation roster.");

  const questionDraft = await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/sessions/${scheduled.id}/messages`, {
    body: "Can we use this workflow for customer support?",
    clientMessageId: `question-${randomUUID()}`,
    kind: "question"
  }, "POST", 201);
  const minaQuestion = questionDraft.messages.find((message) => message.isMine && message.kind === "question");
  assert(minaQuestion?.status === "pending", "Viewer question bypassed moderation.");
  const junBeforePublish = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}`, { cookie: jun.cookie });
  assert(!JSON.stringify(junBeforePublish.body).includes("Can we use this workflow"), "Pending question leaked to another viewer.");
  const hostQueue = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}`, { cookie: owner.cookie });
  const queuedQuestion = hostQueue.body.messages.find((message) => message.body.startsWith("Can we use"));
  assert(queuedQuestion?.sender?.id === mina.userId && queuedQuestion.status === "pending", "Moderator did not receive the attributed question queue.");
  await mutate(
    baseUrl,
    webOrigin,
    owner.cookie,
    `/broadcasts/sessions/${scheduled.id}/messages/${queuedQuestion.id}/moderate`,
    { action: "publish", version: queuedQuestion.version },
    "PATCH"
  );
  const junAfterPublish = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}`, { cookie: jun.cookie });
  const publishedQuestion = junAfterPublish.body.messages.find((message) => message.body.startsWith("Can we use"));
  assert(publishedQuestion?.senderLabel === "Viewer question" && !publishedQuestion.sender, "Published viewer question was not anonymized.");
  assert(!JSON.stringify(junAfterPublish.body).includes(mina.userId) && !JSON.stringify(junAfterPublish.body).includes("Stage7 Mina"), "Published question revealed viewer identity.");

  const announcement = await mutate(baseUrl, webOrigin, owner.cookie, `/broadcasts/sessions/${scheduled.id}/messages`, {
    body: "The private service handoff is available now.",
    clientMessageId: `announcement-${randomUUID()}`,
    kind: "announcement"
  }, "POST", 201);
  const publishedAnnouncement = announcement.messages.find((message) => message.kind === "announcement");
  assert(publishedAnnouncement?.sender?.id === owner.userId && publishedAnnouncement.status === "published", "Host announcement did not preserve stage identity.");

  const firstReactionId = `reaction-${randomUUID()}`;
  const firstReaction = await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/sessions/${scheduled.id}/reactions`, {
    clientReactionId: firstReactionId,
    reaction: "applause"
  }, "POST", 201);
  const replayedReaction = await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/sessions/${scheduled.id}/reactions`, {
    clientReactionId: firstReactionId,
    reaction: "applause"
  }, "POST", 201);
  assert(firstReaction.find((item) => item.reaction === "applause")?.count === 1, "First reaction was not counted.");
  assert(replayedReaction.find((item) => item.reaction === "applause")?.count === 1, "Reaction idempotency duplicated a reaction.");
  for (let index = 2; index <= 10; index += 1) {
    await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/sessions/${scheduled.id}/reactions`, {
      clientReactionId: `reaction-${index}-${randomUUID()}`,
      reaction: "applause"
    }, "POST", 201);
  }
  await mutate(baseUrl, webOrigin, mina.cookie, `/broadcasts/sessions/${scheduled.id}/reactions`, {
    clientReactionId: `reaction-limit-${randomUUID()}`,
    reaction: "applause"
  }, "POST", 429);

  const handoff = await mutate(baseUrl, webOrigin, hana.cookie, `/broadcasts/channels/${channel.id}/private-handoff`, {});
  assert(handoff.created && handoff.owner.id === owner.userId, "Private service handoff did not create an owner-viewer direct conversation.");
  const handoffReplay = await mutate(baseUrl, webOrigin, hana.cookie, `/broadcasts/channels/${channel.id}/private-handoff`, {});
  assert(!handoffReplay.created && handoffReplay.spaceId === handoff.spaceId, "Private handoff idempotency created another conversation.");
  const handoffMembers = await database.query(
    "select user_id from space_memberships where space_id = $1 and status = 'active' order by user_id",
    [handoff.spaceId]
  );
  assert(handoffMembers.rowCount === 2, "Private handoff conversation contains more than owner and requester.");

  await mutate(baseUrl, webOrigin, owner.cookie, `/broadcasts/sessions/${scheduled.id}/participants/${hana.userId}/moderate`, {
    action: "block"
  });
  await mutate(baseUrl, webOrigin, hana.cookie, `/broadcasts/channels/${channel.id}/subscribe`, {
    notificationLevel: "live_only"
  }, "POST", 403);
  const blockedView = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}`, { cookie: hana.cookie });
  assert(blockedView.response.status === 200 && blockedView.body.channel.subscriptionStatus === "blocked" && !blockedView.body.canJoin, "Blocked viewer retained join permission.");
  assert(!JSON.stringify(blockedView.body).includes(mina.userId) && !JSON.stringify(blockedView.body).includes(jun.userId), "Blocked viewer received viewer identities.");

  const latestOwner = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}`, { cookie: owner.cookie });
  const roleFailure = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}/participants/${jun.userId}/role`, {
    cookie: owner.cookie,
    method: "PATCH",
    origin: webOrigin,
    payload: { role: "speaker", version: latestOwner.body.version }
  });
  assert(roleFailure.response.status === 503, "Missing provider participant did not make role synchronization fail closed.");
  const afterRoleFailure = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}`, { cookie: owner.cookie });
  const removedJun = afterRoleFailure.body.moderationParticipants.find((item) => item.person.id === jun.userId);
  assert(removedJun?.status === "removed" && removedJun.role === "viewer" && !removedJun.canPublishAudio, "Role sync failure did not remove and de-privilege the viewer.");

  minaSocket.close();
  minaSocket = undefined;
  await stopChild(api.child);
  api = await startApi(apiPort, webOrigin, livekit.serviceUrl);
  const restored = await request(baseUrl, `/broadcasts/sessions/${scheduled.id}`, { cookie: owner.cookie });
  assert(restored.response.status === 200 && restored.body.status === "live" && restored.body.messages.length >= 2, "Broadcast state did not survive API restart.");

  const ended = await mutate(baseUrl, webOrigin, owner.cookie, `/broadcasts/sessions/${scheduled.id}/end`, {
    version: restored.body.version
  });
  assert(ended.status === "ended" && ended.endReason === "host_ended", "Host did not end the broadcast.");
  assert(ended.replay.status === "unavailable" && ended.replay.unavailableReason === "egress_output_gate_pending" && !ended.replay.canOpen, "Replay was not fail-closed while the Egress output gate is pending.");
  await waitForRoomCount(livekit.client, 0);

  const migration = await database.query("select checksum from schema_migrations where version = '011_personal_broadcast.sql'");
  assert(migration.rowCount === 1 && migration.rows[0].checksum.length === 64, "Broadcast migration checksum was not persisted.");
  const unsafeOutbox = await database.query(
    `select count(*)::int as count from outbox_events
     where aggregate_type = 'broadcast'
       and (payload_json::text like '%provider_room%' or payload_json::text like '%hht_broadcast_%' or payload_json::text like '%Stage7 Mina%' or payload_json::text like '%Stage7 Jun%')`
  );
  assert(unsafeOutbox.rows[0].count === 0, "Broadcast outbox contains provider or viewer identity material.");
  const unsafeAudit = await database.query(
    `select count(*)::int as count from audit_logs
     where action like 'broadcast.%'
       and (metadata_json::text like '%provider%' or metadata_json::text like '%Can we use this workflow%')`
  );
  assert(unsafeAudit.rows[0].count === 0, "Broadcast audit log contains provider internals or message body.");
  const moderationRows = await database.query("select count(*)::int as count from broadcast_moderation_actions where broadcast_session_id = $1", [scheduled.id]);
  assert(moderationRows.rows[0].count >= 3, "Broadcast moderation actions were not append-only recorded.");

  console.log("Personal broadcast integration passed: channel/subscription separation, hidden subscribe-only viewers, live lifecycle, moderated anonymous Q&A, reactions, handoff, block, role fail-closed, restart, and replay boundary.");
} catch (error) {
  await delay(500);
  if (databaseConnected) {
    const diagnostics = await database.query(
      `select bs.id, bs.status, bs.version, bs.started_at, bs.ended_at,
              cs.status as call_status, cs.version as call_version,
              br.status as replay_status
       from broadcast_sessions bs
       join call_sessions cs on cs.id = bs.call_session_id
       left join broadcast_replays br on br.broadcast_session_id = bs.id
       order by bs.created_at desc limit 3`
    ).catch(() => ({ rows: [] }));
    process.stderr.write(`\nBroadcast DB diagnostics:\n${JSON.stringify(diagnostics.rows, null, 2)}\n`);
  }
  if (api?.logs?.length) process.stderr.write(`\nBroadcast API logs:\n${api.logs.join("")}\n`);
  throw error;
} finally {
  if (minaSocket) minaSocket.close();
  if (api) await stopChild(api.child);
  if (livekit) await stopChild(livekit.child);
  if (databaseConnected) await database.end().catch(() => undefined);
  if (adminConnected) {
    await adminDatabase.query(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    await adminDatabase.end().catch(() => undefined);
  }
}
