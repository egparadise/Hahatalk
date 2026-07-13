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
const databaseName = `hahatalk_meetings_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_meetings_session";
const apiKey = "devkey";
const apiSecret = "secret";
const hubId = "00000000-0000-4000-8000-000000000201";
const groupId = "00000000-0000-4000-8000-000000000202";

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
    if (child.exitCode !== null) throw new Error(`Meetings API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // The fresh database is still migrating.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Meetings API did not become healthy.\n${logs.join("")}`);
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

function localInZone(date, timeZone = "Asia/Seoul") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function eventInput(title, startsAt, endsAt, spaceId, attendeeIds, visibility = "attendees") {
  return {
    allDay: false,
    attendeeIds,
    description: "Stage 6C integration",
    endsLocal: localInZone(endsAt),
    location: "HahaTalk meeting room",
    reminderOffsetsMinutes: [],
    spaceId,
    startsLocal: localInZone(startsAt),
    timezone: "Asia/Seoul",
    title,
    visibility
  };
}

async function createEvent(baseUrl, webOrigin, cookie, input, expected = 201) {
  return mutate(baseUrl, webOrigin, cookie, "/calendar/events", input, "POST", expected);
}

async function scheduleMeeting(baseUrl, webOrigin, cookie, input, expected = 201) {
  return mutate(baseUrl, webOrigin, cookie, "/meetings", input, "POST", expected);
}

async function connectSocket(baseUrl, cookie, spaceId) {
  const socket = io(baseUrl, { extraHeaders: { Cookie: cookie }, transports: ["websocket"] });
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    }),
    delay(5_000).then(() => { throw new Error("Meeting realtime socket did not connect."); })
  ]);
  socket.emit("room:join", { spaceId });
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
let ownerSocket;

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

  const owner = await signup(baseUrl, webOrigin, "you@inviz.co.kr", "Stage6C!OwnerPass", "Stage6C Owner", "char-calm-lead");
  const mina = await signup(baseUrl, webOrigin, "mina@inviz.co.kr", "Stage6C!MinaPass", "Stage6C Mina", "char-focus-maker");
  const jun = await signup(baseUrl, webOrigin, "jun@inviz.co.kr", "Stage6C!JunPass", "Stage6C Jun", "char-calm-lead");
  const hana = await signup(baseUrl, webOrigin, "hana.customer@example.com", "Stage6C!HanaPass", "Stage6C Hana", "char-customer-guest");

  const now = new Date();
  const startsAt = new Date(now.getTime() + 10 * 60_000);
  const endsAt = new Date(now.getTime() + 70 * 60_000);
  const groupEvent = await createEvent(
    baseUrl,
    webOrigin,
    owner.cookie,
    eventInput("Stage 6C group meeting", startsAt, endsAt, groupId, [mina.userId, jun.userId])
  );
  await mutate(baseUrl, webOrigin, mina.cookie, `/calendar/events/${groupEvent.id}/rsvp`, { response: "accepted" });
  await mutate(baseUrl, webOrigin, jun.cookie, `/calendar/events/${groupEvent.id}/rsvp`, { response: "accepted" });

  const meetingInput = {
    callType: "video",
    clientMeetingId: `meeting-group-${randomUUID()}`,
    eventId: groupEvent.id,
    occurrenceStartsAt: groupEvent.startsAt,
    roleAssignments: [
      { role: "cohost", userId: mina.userId },
      { role: "speaker", userId: jun.userId }
    ]
  };
  const meeting = await scheduleMeeting(baseUrl, webOrigin, owner.cookie, meetingInput);
  assert(meeting.status === "scheduled" && meeting.myRole === "host" && meeting.participants.length === 3, "Scheduled meeting snapshot is incomplete.");
  assert(meeting.participants.find((item) => item.person.id === mina.userId)?.role === "cohost", "Cohost role was not snapshotted.");
  assert(meeting.participants.find((item) => item.person.id === jun.userId)?.role === "speaker", "Speaker role was not snapshotted.");
  assert(!JSON.stringify(meeting).includes(apiSecret) && !JSON.stringify(meeting).includes("hht_meeting_"), "Meeting projection exposed provider internals.");

  const replay = await scheduleMeeting(baseUrl, webOrigin, owner.cookie, meetingInput);
  assert(replay.id === meeting.id, "Meeting idempotency replay created a second meeting.");
  await scheduleMeeting(baseUrl, webOrigin, owner.cookie, { ...meetingInput, callType: "voice" }, 409);
  await scheduleMeeting(baseUrl, webOrigin, owner.cookie, {
    ...meetingInput,
    clientMeetingId: `meeting-forged-time-${randomUUID()}`,
    occurrenceStartsAt: new Date(new Date(groupEvent.startsAt).getTime() + 60_000).toISOString()
  }, 400);
  await scheduleMeeting(baseUrl, webOrigin, mina.cookie, {
    ...meetingInput,
    clientMeetingId: `meeting-not-owner-${randomUUID()}`
  }, 404);
  await scheduleMeeting(baseUrl, webOrigin, owner.cookie, {
    ...meetingInput,
    clientMeetingId: `meeting-role-forged-${randomUUID()}`,
    roleAssignments: [{ role: "speaker", userId: hana.userId }]
  }, 403);
  await mutate(baseUrl, webOrigin, owner.cookie, `/calendar/events/${groupEvent.id}`, {
    ...eventInput("Blocked edit", startsAt, endsAt, groupId, [mina.userId, jun.userId]),
    version: groupEvent.version
  }, "PATCH", 409);

  const unauthorized = await request(baseUrl, `/meetings/${meeting.id}`, { cookie: hana.cookie });
  assert(unauthorized.response.status === 404, "Non-participant inspected a scheduled meeting.");
  const occurrenceView = await request(
    baseUrl,
    `/meetings?eventId=${encodeURIComponent(groupEvent.id)}&occurrenceStartsAt=${encodeURIComponent(groupEvent.startsAt)}`,
    { cookie: mina.cookie }
  );
  assert(occurrenceView.response.status === 200 && occurrenceView.body.id === meeting.id, "Attendee could not resolve the occurrence meeting.");

  const opened = await mutate(baseUrl, webOrigin, owner.cookie, `/meetings/${meeting.id}/open`, { version: meeting.version });
  assert(opened.status === "lobby_open" && opened.openedAt, "Host did not open the meeting lobby.");
  const roomRows = await database.query("select provider_room_name from call_sessions where id = $1", [meeting.id]);
  const groupRoomName = roomRows.rows[0].provider_room_name;
  const rooms = await waitForRoomCount(livekit.client, 1);
  assert(rooms[0]?.name === groupRoomName && rooms[0]?.maxParticipants === 3, "Provider room did not match the meeting snapshot.");

  ownerSocket = await connectSocket(baseUrl, owner.cookie, groupId);
  const waitingEvent = nextEvent(
    ownerSocket,
    "meeting:updated",
    (payload) => payload.id === meeting.id && payload.waitingCount === 1
  );
  const junWaiting = await mutate(baseUrl, webOrigin, jun.cookie, `/meetings/${meeting.id}/enter`, {});
  assert(junWaiting.myStatus === "waiting" && !junWaiting.canJoin, "Speaker bypassed the waiting room.");
  assert(!Object.prototype.hasOwnProperty.call(junWaiting, "waitingCount"), "A non-moderator received the waiting-room count.");
  await mutate(baseUrl, webOrigin, jun.cookie, `/meetings/${meeting.id}/join`, {}, "POST", 409);
  const realtimeWaiting = await waitingEvent;
  assert(realtimeWaiting.id === meeting.id && realtimeWaiting.waitingCount === 1, "Waiting-room realtime update was not moderator-scoped.");

  const minaEntered = await mutate(baseUrl, webOrigin, mina.cookie, `/meetings/${meeting.id}/enter`, {});
  assert(minaEntered.myStatus === "admitted" && minaEntered.canAdmit, "Cohost did not enter with moderator admission.");
  await mutate(baseUrl, webOrigin, mina.cookie, `/meetings/${meeting.id}/participants/${jun.userId}/admit`, {});
  const junJoin = await mutate(baseUrl, webOrigin, jun.cookie, `/meetings/${meeting.id}/join`, {});
  const junClaims = await new TokenVerifier(apiKey, apiSecret).verify(junJoin.token);
  assert(junClaims.video?.room === groupRoomName && junClaims.video?.canPublish === true, "Speaker token targeted the wrong room or denied publish.");
  assert(
    JSON.stringify(junClaims.video?.canPublishSources) === JSON.stringify(["microphone", "camera"]),
    "Speaker token was not source-limited to microphone and camera."
  );
  assert(!JSON.stringify(junClaims.video?.canPublishSources).includes("screen_share"), "Initial meeting token granted screen sharing before an explicit request.");
  assert(!junClaims.video?.roomAdmin && !junClaims.video?.canPublishData, "Speaker token granted moderation or data publishing.");
  const junConnected = await mutate(baseUrl, webOrigin, jun.cookie, `/meetings/${meeting.id}/connected`, {});
  assert(junConnected.canShareScreen, "Connected speaker did not receive the screen-share capability.");
  await mutate(baseUrl, webOrigin, jun.cookie, `/meetings/${meeting.id}/screen-share/active`, {}, "POST", 409);
  const missingScreenPublisher = await mutate(baseUrl, webOrigin, jun.cookie, `/meetings/${meeting.id}/screen-share/start`, {}, "POST", 503);
  assert(String(missingScreenPublisher.message).includes("Screen sharing permission"), "Missing provider speaker did not roll back the screen-share request.");
  const rolledBackSpeaker = await request(baseUrl, `/meetings/${meeting.id}`, { cookie: jun.cookie });
  assert(
    rolledBackSpeaker.body.participants.find((participant) => participant.isSelf)?.screenShareStatus === "off",
    "Meeting provider grant failure left the speaker screen share locked."
  );

  const ownerJoin = await mutate(baseUrl, webOrigin, owner.cookie, `/meetings/${meeting.id}/join`, {});
  const ownerClaims = await new TokenVerifier(apiKey, apiSecret).verify(ownerJoin.token);
  assert(ownerClaims.sub !== owner.userId && ownerClaims.video?.room === groupRoomName, "Host token exposed a stable app identity or wrong room.");
  await mutate(baseUrl, webOrigin, owner.cookie, `/meetings/${meeting.id}/connected`, {});

  const versionAfterJoin = (await request(baseUrl, `/meetings/${meeting.id}`, { cookie: owner.cookie })).body.version;
  const providerSyncFailure = await request(baseUrl, `/meetings/${meeting.id}/participants/${jun.userId}/role`, {
    cookie: owner.cookie,
    method: "PATCH",
    origin: webOrigin,
    payload: { role: "attendee", version: versionAfterJoin }
  });
  assert(providerSyncFailure.response.status === 503, "Role/provider mismatch did not fail closed when the app claimed a missing provider participant.");
  const removedJun = await request(baseUrl, `/meetings/${meeting.id}`, { cookie: owner.cookie });
  assert(removedJun.body.participants.find((item) => item.person.id === jun.userId)?.status === "removed", "Provider role sync failure did not remove the participant.");

  ownerSocket.close();
  ownerSocket = undefined;
  await stopChild(api.child);
  api = await startApi(apiPort, webOrigin, livekit.serviceUrl);
  const restartMeeting = await request(baseUrl, `/meetings/${meeting.id}`, { cookie: owner.cookie });
  assert(restartMeeting.response.status === 200 && restartMeeting.body.status === "active", "Meeting state did not survive API restart.");
  const ended = await mutate(baseUrl, webOrigin, owner.cookie, `/meetings/${meeting.id}/end`, { version: restartMeeting.body.version });
  assert(ended.status === "ended" && ended.endReason === "host_ended", "Host did not end the scheduled meeting.");
  await waitForRoomCount(livekit.client, 0);

  const hubWideEvent = await createEvent(
    baseUrl,
    webOrigin,
    owner.cookie,
    eventInput("Forbidden multi-spoke hub meeting", startsAt, endsAt, hubId, [], "space")
  );
  await scheduleMeeting(baseUrl, webOrigin, owner.cookie, {
    callType: "video",
    clientMeetingId: `meeting-hub-multi-${randomUUID()}`,
    eventId: hubWideEvent.id,
    occurrenceStartsAt: hubWideEvent.startsAt,
    roleAssignments: []
  }, 400);

  const guestStartsAt = new Date(now.getTime() + 12 * 60_000);
  const guestEndsAt = new Date(now.getTime() + 72 * 60_000);
  const guestEvent = await createEvent(
    baseUrl,
    webOrigin,
    owner.cookie,
    eventInput("Private guest meeting", guestStartsAt, guestEndsAt, hubId, [hana.userId])
  );
  await scheduleMeeting(baseUrl, webOrigin, owner.cookie, {
    callType: "video",
    clientMeetingId: `meeting-guest-role-${randomUUID()}`,
    eventId: guestEvent.id,
    occurrenceStartsAt: guestEvent.startsAt,
    roleAssignments: [{ role: "speaker", userId: hana.userId }]
  }, 403);
  const guestMeeting = await scheduleMeeting(baseUrl, webOrigin, owner.cookie, {
    callType: "video",
    clientMeetingId: `meeting-guest-${randomUUID()}`,
    eventId: guestEvent.id,
    occurrenceStartsAt: guestEvent.startsAt,
    roleAssignments: []
  });
  await mutate(baseUrl, webOrigin, owner.cookie, `/meetings/${guestMeeting.id}/open`, { version: guestMeeting.version });
  await mutate(baseUrl, webOrigin, hana.cookie, `/meetings/${guestMeeting.id}/enter`, {});
  await mutate(baseUrl, webOrigin, owner.cookie, `/meetings/${guestMeeting.id}/participants/${hana.userId}/admit`, {});
  const guestJoin = await mutate(baseUrl, webOrigin, hana.cookie, `/meetings/${guestMeeting.id}/join`, {});
  const guestClaims = await new TokenVerifier(apiKey, apiSecret).verify(guestJoin.token);
  assert(guestClaims.video?.canPublish === false && guestClaims.video?.canSubscribe === true, "Guest attendee token was not subscribe-only.");
  const guestConnected = await mutate(baseUrl, webOrigin, hana.cookie, `/meetings/${guestMeeting.id}/connected`, {});
  assert(!guestConnected.canShareScreen, "Guest attendee projection exposed screen sharing.");
  await mutate(baseUrl, webOrigin, hana.cookie, `/meetings/${guestMeeting.id}/screen-share/start`, {}, "POST", 403);
  const guestProjection = JSON.stringify(guestJoin.meeting);
  assert(guestJoin.meeting.participants.length === 2 && !guestProjection.includes(mina.userId) && !guestProjection.includes(jun.userId), "Hidden hub guest projection leaked another spoke.");
  const guestCurrent = await request(baseUrl, `/meetings/${guestMeeting.id}`, { cookie: owner.cookie });
  await mutate(baseUrl, webOrigin, owner.cookie, `/meetings/${guestMeeting.id}/end`, { version: guestCurrent.body.version });
  await waitForRoomCount(livekit.client, 0);

  const declinedStartsAt = new Date(now.getTime() + 14 * 60_000);
  const declinedEndsAt = new Date(now.getTime() + 74 * 60_000);
  const declinedEvent = await createEvent(
    baseUrl,
    webOrigin,
    owner.cookie,
    eventInput("Declined attendee meeting", declinedStartsAt, declinedEndsAt, hubId, [mina.userId])
  );
  await mutate(baseUrl, webOrigin, mina.cookie, `/calendar/events/${declinedEvent.id}/rsvp`, { response: "declined" });
  const declinedMeeting = await scheduleMeeting(baseUrl, webOrigin, owner.cookie, {
    callType: "voice",
    clientMeetingId: `meeting-declined-${randomUUID()}`,
    eventId: declinedEvent.id,
    occurrenceStartsAt: declinedEvent.startsAt,
    roleAssignments: []
  });
  assert(declinedMeeting.participants.find((item) => item.person.id === mina.userId)?.status === "declined", "Declined RSVP was not frozen into the meeting snapshot.");
  await mutate(baseUrl, webOrigin, owner.cookie, `/meetings/${declinedMeeting.id}/open`, { version: declinedMeeting.version });
  await mutate(baseUrl, webOrigin, mina.cookie, `/meetings/${declinedMeeting.id}/enter`, {}, "POST", 409);
  const currentDeclined = await request(baseUrl, `/meetings/${declinedMeeting.id}`, { cookie: owner.cookie });
  await mutate(baseUrl, webOrigin, owner.cookie, `/meetings/${declinedMeeting.id}/end`, { version: currentDeclined.body.version });
  await waitForRoomCount(livekit.client, 0);

  const failureStartsAt = new Date(now.getTime() + 16 * 60_000);
  const failureEndsAt = new Date(now.getTime() + 76 * 60_000);
  const failureEvent = await createEvent(
    baseUrl,
    webOrigin,
    owner.cookie,
    eventInput("Provider failure meeting", failureStartsAt, failureEndsAt, hubId, [mina.userId])
  );
  const failureMeeting = await scheduleMeeting(baseUrl, webOrigin, owner.cookie, {
    callType: "voice",
    clientMeetingId: `meeting-provider-failure-${randomUUID()}`,
    eventId: failureEvent.id,
    occurrenceStartsAt: failureEvent.startsAt,
    roleAssignments: []
  });
  await stopChild(livekit.child);
  const providerFailure = await request(baseUrl, `/meetings/${failureMeeting.id}/open`, {
    cookie: owner.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { version: failureMeeting.version }
  });
  assert(providerFailure.response.status === 503, "Provider-down meeting open did not fail closed.");
  const failedMeeting = await request(baseUrl, `/meetings/${failureMeeting.id}`, { cookie: owner.cookie });
  assert(failedMeeting.body.status === "failed", "Provider-down meeting was not marked failed.");

  const migration = await database.query("select checksum from schema_migrations where version = '008_scheduled_meeting_lobby.sql'");
  assert(migration.rowCount === 1 && /^[0-9a-f]{64}$/.test(migration.rows[0].checksum), "Migration 008 checksum evidence is missing.");
  const screenMigration = await database.query("select checksum from schema_migrations where version = '009_screen_share_device_background.sql'");
  assert(screenMigration.rowCount === 1 && /^[0-9a-f]{64}$/.test(screenMigration.rows[0].checksum), "Migration 009 checksum evidence is missing.");
  const audit = await database.query(
    `select action, metadata_json::text as metadata from audit_logs
     where target_type = 'call_session' and action like 'meeting.%' order by created_at`
  );
  for (const action of [
    "meeting.scheduled",
    "meeting.lobby_opened",
    "meeting.participant_waiting",
    "meeting.participant_admitted",
    "meeting.participant_joined",
    "meeting.screen_share_requested",
    "meeting.screen_share_provider_grant_failed",
    "meeting.role_changed",
    "meeting.role_provider_sync_failed",
    "meeting.ended",
    "meeting.provider_start_failed"
  ]) {
    assert(audit.rows.some((row) => row.action === action), `Meeting audit action is missing: ${action}`);
  }
  const outbox = await database.query("select payload_json::text as payload from outbox_events where aggregate_type = 'meeting'");
  const durableText = JSON.stringify({ audit: audit.rows, outbox: outbox.rows });
  assert(!durableText.includes(apiSecret) && !durableText.includes("eyJ") && !durableText.includes(groupRoomName), "Meeting audit/outbox exposed a secret, token, or provider room name.");

  console.log("Scheduled meeting integration passed: occurrence binding, roles, screen-share role boundaries and grant rollback, waiting/admission, scoped tokens, hub privacy, guest boundary, restart, provider failure, and audit verified.");
} finally {
  ownerSocket?.close();
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
