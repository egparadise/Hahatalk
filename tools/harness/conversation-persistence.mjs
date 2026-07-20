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
const databaseName = `hahatalk_conversation_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_conversation_session";
const clientHeader = { "X-HahaTalk-Client": "web-v1" };
const hubId = "00000000-0000-4000-8000-000000000201";
const groupId = "00000000-0000-4000-8000-000000000202";
const directId = "00000000-0000-4000-8000-000000000203";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Conversation API exited during startup.\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // The API is still applying migrations or opening the listener.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Conversation API did not become healthy.\n${logs.join("")}`);
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
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
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
  assert(result.response.status === 201, `Signup failed for ${email}: ${result.response.status}.`);
  const me = result.body;
  return { cookie: responseCookie(result.response), userId: me.user.id };
}

async function send(baseUrl, webOrigin, cookie, payload, expectedStatus = 201) {
  const result = await request(baseUrl, "/messages", {
    cookie,
    method: "POST",
    origin: webOrigin,
    payload: {
      audienceType: "all",
      clientMessageId: `stage3-${randomUUID()}`,
      requiresConfirmation: false,
      targetUserIds: [],
      ...payload
    }
  });
  assert(
    result.response.status === expectedStatus,
    `Message send returned ${result.response.status}, expected ${expectedStatus}: ${JSON.stringify(result.body)}`
  );
  return result.body;
}

async function connectSocket(baseUrl, webOrigin, cookie, spaceId) {
  const socket = io(baseUrl, {
    extraHeaders: { Cookie: cookie, Origin: webOrigin },
    forceNew: true,
    reconnection: false,
    timeout: 3_000,
    transports: ["websocket"]
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  await new Promise((resolve, reject) => {
    socket.timeout(3_000).emit("room:join", { spaceId }, (error, snapshot) => {
      if (error) reject(error);
      else resolve(snapshot);
    });
  });
  return socket;
}

function waitForEvent(socket, event, predicate = () => true, timeout = 3_000) {
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

const adminDatabase = new Client({ connectionString: adminUrl.toString() });
const database = new Client({ connectionString: databaseUrl });
let adminConnected = false;
let databaseConnected = false;
let api;
const sockets = [];

try {
  await adminDatabase.connect();
  adminConnected = true;
  await adminDatabase.query(`create database "${databaseName}"`);
  await database.connect();
  databaseConnected = true;

  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const webOrigin = `http://127.0.0.1:${await findAvailablePort()}`;
  api = await startApi(port, webOrigin);

  const owner = await signup(baseUrl, webOrigin, "you@inviz.co.kr", "Stage3!OwnerPass", "Stage3 Owner", "char-calm-lead");
  const mina = await signup(baseUrl, webOrigin, "mina@inviz.co.kr", "Stage3!MinaPass", "Stage3 Mina", "char-focus-maker");
  const jun = await signup(baseUrl, webOrigin, "jun@inviz.co.kr", "Stage3!JunPass", "Stage3 Jun", "char-bright-helper");
  const hana = await signup(baseUrl, webOrigin, "hana.customer@example.com", "Stage3!HanaPass", "Stage3 Hana", "char-calm-lead");

  const ownerSnapshot = await request(baseUrl, `/mvp?spaceId=${hubId}`, { cookie: owner.cookie });
  assert(ownerSnapshot.response.status === 200, "Owner persisted snapshot failed.");
  assert(ownerSnapshot.body.room.mode === "hub_owner", "Owner did not receive the hub console projection.");
  assert(ownerSnapshot.body.spaces.length === 4, "Owner conversation list did not contain the seeded spaces and local assistant.");
  assert(ownerSnapshot.body.spaces.some((space) => space.room.assistant?.model === "Qwen3.5-4B"), "Owner conversation list omitted the local assistant.");

  const minaHub = await request(baseUrl, `/spaces/${hubId}/view`, { cookie: mina.cookie });
  assert(minaHub.response.status === 200, "Participant hub view failed.");
  assert(minaHub.body.room.mode === "direct", "Hub participant was told that the room is a hub.");
  assert(minaHub.body.users.length === 2, "Hub participant received the hidden roster.");
  assert(!JSON.stringify(minaHub.body).includes(jun.userId), "Hub participant projection leaked another participant.");

  const normalized = await send(baseUrl, webOrigin, mina.cookie, {
    audienceType: "all",
    body: "Participant request must stay between participant and owner.",
    spaceId: hubId,
    targetUserIds: [jun.userId]
  });
  assert(normalized.message.deliveryMode === "direct", "Participant hub message was not normalized to direct delivery.");
  assert(normalized.message.deliveries.length === 1, "Participant projection leaked the owner's delivery state.");
  const normalizedAudience = await database.query(
    `select target.public_id
     from message_audiences ma join users target on target.id = ma.target_user_id
     where ma.message_id = $1`,
    [normalized.message.id]
  );
  assert(normalizedAudience.rows[0]?.public_id === owner.userId, "Participant manipulated the hub audience target.");
  const participantReport = await request(baseUrl, `/messages/${normalized.message.id}/read-report`, { cookie: mina.cookie });
  assert(participantReport.response.status === 200 && participantReport.body.length === 2, "Hub participant could not inspect owner read state for their own spoke message.");
  const junAfterNormalized = await request(baseUrl, `/spaces/${hubId}/view`, { cookie: jun.cookie });
  assert(!junAfterNormalized.body.messages.some((message) => message.id === normalized.message.id), "Hub spoke message leaked to another participant.");

  const selected = await send(baseUrl, webOrigin, owner.cookie, {
    audienceType: "selected",
    body: "Selected Mina only Stage 3 marker",
    spaceId: hubId,
    targetUserIds: [mina.userId]
  });
  assert(selected.message.deliveries.length === 2, "Owner selected delivery did not include exactly owner and target.");
  const minaSelected = await request(baseUrl, `/spaces/${hubId}/view`, { cookie: mina.cookie });
  const junSelected = await request(baseUrl, `/spaces/${hubId}/view`, { cookie: jun.cookie });
  assert(minaSelected.body.messages.some((message) => message.id === selected.message.id), "Selected hub recipient did not receive the message.");
  assert(!junSelected.body.messages.some((message) => message.id === selected.message.id), "Selected hub message leaked to an unselected member.");

  const announcement = await send(baseUrl, webOrigin, owner.cookie, {
    audienceType: "all",
    body: "Stage 3 public announcement",
    requiresConfirmation: true,
    spaceId: hubId
  });
  assert(announcement.message.deliveries.length === 4, "Hub announcement did not fan out to all active members.");
  const hiddenAdminReport = await request(baseUrl, `/messages/${announcement.message.id}/read-report`, { cookie: mina.cookie });
  assert(hiddenAdminReport.response.status === 403, "Hidden hub admin opened the owner's announcement report.");
  const hiddenAdminDelete = await request(baseUrl, `/messages/${announcement.message.id}`, {
    cookie: mina.cookie,
    method: "DELETE",
    origin: webOrigin
  });
  assert(hiddenAdminDelete.response.status === 403, "Hidden hub admin deleted the owner's announcement.");
  const participantConfirmation = await request(baseUrl, `/messages/${announcement.message.id}/confirm`, {
    cookie: mina.cookie,
    method: "POST",
    origin: webOrigin,
    payload: {}
  });
  assert(
    participantConfirmation.response.status === 201
      && participantConfirmation.body.deliveries.length === 1
      && participantConfirmation.body.deliveries[0].confirmedAt,
    "Hub participant could not confirm their own announcement delivery safely."
  );
  const hanaAnnouncement = await request(baseUrl, `/spaces/${hubId}/view`, { cookie: hana.cookie });
  assert(hanaAnnouncement.body.messages.some((message) => message.id === announcement.message.id), "Hub announcement did not reach the guest.");

  const groupMessage = await send(baseUrl, webOrigin, jun.cookie, {
    body: "Stage 3 shared group message",
    spaceId: groupId
  });
  const ownerGroup = await request(baseUrl, `/spaces/${groupId}/view`, { cookie: owner.cookie });
  const minaGroup = await request(baseUrl, `/spaces/${groupId}/view`, { cookie: mina.cookie });
  assert(ownerGroup.body.messages.some((message) => message.id === groupMessage.message.id), "Group message did not reach owner.");
  assert(minaGroup.body.messages.some((message) => message.id === groupMessage.message.id), "Group message did not reach another member.");

  const directMessage = await send(baseUrl, webOrigin, mina.cookie, {
    audienceType: "all",
    body: "Stage 3 persisted direct message",
    spaceId: directId,
    targetUserIds: [jun.userId]
  });
  assert(directMessage.message.deliveryMode === "direct", "Direct conversation accepted a non-direct delivery mode.");
  assert(directMessage.message.deliveries.length === 2, "Direct message did not deliver to both members.");

  const idempotencyKey = `stage3-idempotent-${randomUUID()}`;
  const idempotentPayload = {
    audienceType: "all",
    body: "Stage 3 idempotency marker",
    clientMessageId: idempotencyKey,
    spaceId: groupId
  };
  const firstIdempotent = await send(baseUrl, webOrigin, owner.cookie, idempotentPayload);
  const replayed = await send(baseUrl, webOrigin, owner.cookie, idempotentPayload);
  assert(replayed.replay === true, "Repeated idempotency key was not reported as a replay.");
  assert(firstIdempotent.message.id === replayed.message.id, "Idempotent replay created a different message.");
  await send(baseUrl, webOrigin, owner.cookie, { ...idempotentPayload, body: "Changed body" }, 409);

  const concurrentKey = `stage3-concurrent-${randomUUID()}`;
  const concurrentPayload = {
    audienceType: "all",
    body: "Stage 3 concurrent idempotency marker",
    clientMessageId: concurrentKey,
    spaceId: groupId
  };
  const concurrent = await Promise.all([
    send(baseUrl, webOrigin, owner.cookie, concurrentPayload),
    send(baseUrl, webOrigin, owner.cookie, concurrentPayload)
  ]);
  assert(concurrent[0].message.id === concurrent[1].message.id, "Concurrent duplicate created multiple message ids.");
  const duplicateCount = await database.query("select count(*)::int as count from messages where client_message_id = $1", [concurrentKey]);
  assert(duplicateCount.rows[0].count === 1, "Concurrent duplicate inserted more than one message row.");

  for (let index = 0; index < 5; index += 1) {
    await send(baseUrl, webOrigin, owner.cookie, { body: `Stage 3 pagination ${index}`, spaceId: groupId });
  }
  const firstPage = await request(baseUrl, `/spaces/${groupId}/view?limit=2`, { cookie: owner.cookie });
  assert(firstPage.body.messages.length === 2 && firstPage.body.hasMore, "First keyset page is invalid.");
  assert(firstPage.body.nextCursor, "Keyset page did not return a next cursor.");
  const secondPage = await request(
    baseUrl,
    `/spaces/${groupId}/view?limit=2&before=${encodeURIComponent(firstPage.body.nextCursor)}`,
    { cookie: owner.cookie }
  );
  const firstIds = new Set(firstPage.body.messages.map((message) => message.id));
  assert(secondPage.body.messages.every((message) => !firstIds.has(message.id)), "Keyset pages overlapped.");

  const confirmable = await send(baseUrl, webOrigin, owner.cookie, {
    body: "Stage 3 confirm marker",
    requiresConfirmation: true,
    spaceId: groupId
  });
  const read = await request(baseUrl, `/messages/${confirmable.message.id}/read`, {
    cookie: mina.cookie,
    method: "POST",
    origin: webOrigin,
    payload: {}
  });
  assert(read.response.status === 201, "Read marker failed.");
  const readDelivery = read.body.deliveries.find((delivery) => delivery.recipientId === mina.userId);
  assert(readDelivery?.readAt && !readDelivery.confirmedAt, "Read marker did not preserve separate confirmation state.");
  const confirmed = await request(baseUrl, `/messages/${confirmable.message.id}/confirm`, {
    cookie: mina.cookie,
    method: "POST",
    origin: webOrigin,
    payload: {}
  });
  const confirmedDelivery = confirmed.body.deliveries.find((delivery) => delivery.recipientId === mina.userId);
  assert(confirmedDelivery.readAt === readDelivery.readAt, "Confirmation rewrote the original read time.");
  assert(confirmedDelivery.confirmedAt, "Confirmation time was not stored.");
  await request(baseUrl, `/messages/${groupMessage.message.id}/read`, {
    cookie: mina.cookie,
    method: "POST",
    origin: webOrigin,
    payload: {}
  });
  const lastReadPointer = await database.query(
    `select sm.last_read_message_id
     from space_memberships sm join users u on u.id = sm.user_id
     where sm.space_id = $1 and u.public_id = $2`,
    [groupId, mina.userId]
  );
  assert(lastReadPointer.rows[0].last_read_message_id === confirmable.message.id, "Reading an older message regressed the membership read cursor.");
  const report = await request(baseUrl, `/messages/${confirmable.message.id}/read-report`, { cookie: owner.cookie });
  assert(report.response.status === 200 && report.body.length === 3, "Owner read report is incomplete.");
  const deniedReport = await request(baseUrl, `/messages/${confirmable.message.id}/read-report`, { cookie: jun.cookie });
  assert(deniedReport.response.status === 403, "Unprivileged member opened another sender's read report.");

  const editable = await send(baseUrl, webOrigin, owner.cookie, { body: "Stage 3 before edit", spaceId: groupId });
  const edited = await request(baseUrl, `/messages/${editable.message.id}`, {
    cookie: owner.cookie,
    method: "PATCH",
    origin: webOrigin,
    payload: { body: "Stage 3 searchable edited marker" }
  });
  assert(edited.response.status === 200 && edited.body.editedAt, "Message edit was not persisted.");
  const deniedEdit = await request(baseUrl, `/messages/${editable.message.id}`, {
    cookie: jun.cookie,
    method: "PATCH",
    origin: webOrigin,
    payload: { body: "Unauthorized edit" }
  });
  assert(deniedEdit.response.status === 403, "Another member edited the author's message.");
  const search = await request(baseUrl, `/spaces/${groupId}/search?q=${encodeURIComponent("searchable edited")}`, { cookie: mina.cookie });
  assert(search.body.some((message) => message.id === editable.message.id), "Delivery-scoped search missed the edited message.");
  const hiddenSearch = await request(baseUrl, `/spaces/${hubId}/search?q=${encodeURIComponent("Selected Mina only")}`, { cookie: jun.cookie });
  assert(hiddenSearch.response.status === 200 && hiddenSearch.body.length === 0, "Search leaked a hidden hub message.");
  const reply = await send(baseUrl, webOrigin, mina.cookie, {
    body: "Stage 3 reply marker",
    parentMessageId: editable.message.id,
    spaceId: groupId
  });
  assert(reply.message.parentMessageId === editable.message.id, "Reply relationship was not stored.");

  const ownerSocket = await connectSocket(baseUrl, webOrigin, owner.cookie, hubId);
  const minaSocket = await connectSocket(baseUrl, webOrigin, mina.cookie, hubId);
  const junSocket = await connectSocket(baseUrl, webOrigin, jun.cookie, hubId);
  sockets.push(ownerSocket, minaSocket, junSocket);
  let junReceivedSelected = false;
  const junListener = (message) => {
    if (message.body === "Stage 3 realtime selected marker") junReceivedSelected = true;
  };
  junSocket.on("message:created", junListener);
  const minaRealtimePromise = waitForEvent(
    minaSocket,
    "message:created",
    (message) => message.body === "Stage 3 realtime selected marker"
  );
  const realtimeSelected = await send(baseUrl, webOrigin, owner.cookie, {
    audienceType: "selected",
    body: "Stage 3 realtime selected marker",
    spaceId: hubId,
    targetUserIds: [mina.userId]
  });
  const realtimeProjection = await minaRealtimePromise;
  assert(realtimeProjection.id === realtimeSelected.message.id, "Realtime message projection did not match the stored message.");
  await delay(500);
  assert(!junReceivedSelected, "Realtime selected message leaked to another participant socket.");
  junSocket.off("message:created", junListener);

  let junReceivedTyping = false;
  const junTypingListener = () => { junReceivedTyping = true; };
  junSocket.on("typing:updated", junTypingListener);
  const ownerTypingPromise = waitForEvent(ownerSocket, "typing:updated", (update) => update.userId === mina.userId);
  await new Promise((resolve, reject) => {
    minaSocket.timeout(3_000).emit("typing:set", {
      active: true,
      spaceId: hubId,
      targetUserIds: [jun.userId]
    }, (error) => error ? reject(error) : resolve());
  });
  await ownerTypingPromise;
  await delay(300);
  assert(!junReceivedTyping, "Hub participant typing state leaked to another spoke.");
  junSocket.off("typing:updated", junTypingListener);

  const deleted = await request(baseUrl, `/messages/${editable.message.id}`, {
    cookie: owner.cookie,
    method: "DELETE",
    origin: webOrigin,
    payload: {}
  });
  assert(deleted.response.status === 200 && deleted.body.deletedAt, "Message delete failed.");
  const afterDelete = await request(baseUrl, `/spaces/${groupId}/search?q=${encodeURIComponent("searchable edited")}`, { cookie: owner.cookie });
  assert(afterDelete.body.length === 0, "Deleted message remained searchable.");

  const outboxShape = await database.query(
    `select count(*)::int as count
     from outbox_events
     where jsonb_typeof(payload_json -> 'recipientInternalId') <> 'string'
        or payload_json ? 'recipientInternalIds'`
  );
  assert(outboxShape.rows[0].count === 0, "Outbox contains a shared recipient list instead of one recipient per event.");

  const persistedId = realtimeSelected.message.id;
  for (const socket of sockets.splice(0)) socket.close();
  await stopApi(api);
  api = await startApi(port, webOrigin);
  const afterRestart = await request(baseUrl, `/spaces/${hubId}/view`, { cookie: mina.cookie });
  assert(afterRestart.response.status === 200, "Session or conversation failed after API restart.");
  assert(afterRestart.body.messages.some((message) => message.id === persistedId), "Stored conversation disappeared after API restart.");

  console.log("Conversation persistence check passed: hub privacy, direct/group delivery, idempotency, pagination, read/confirm, CRUD/search, outbox realtime, typing privacy, and restart restore.");
} finally {
  for (const socket of sockets) socket.close();
  await stopApi(api);
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
