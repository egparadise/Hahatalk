import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

const require = createRequire(import.meta.url);
const { validateCommand } = require(path.join(process.cwd(), "apps", "desktop", "remote-support-agent.cjs"));
const root = process.cwd();
const apiEntry = path.join(root, "apps", "api", "dist", "main.js");
const migrationsDirectory = path.join(root, "apps", "api", "migrations");
const baseDatabaseUrl = process.env.DATABASE_URL
  ?? "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const databaseName = `hahatalk_remote_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_remote_session";
const organizationId = "00000000-0000-4000-8000-000000000001";
const hubId = "00000000-0000-4000-8000-000000000201";
const groupId = "00000000-0000-4000-8000-000000000202";
const users = {
  guest: { internalId: "00000000-0000-4000-8000-000000000104", publicId: "guest-hana" },
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
    if (child.exitCode !== null) throw new Error(`Remote support API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // Fresh migrations can take several seconds on Windows.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Remote support API did not become healthy.\n${logs.join("")}`);
}

async function stopApi(api) {
  if (!api?.child || api.child.exitCode !== null) return;
  api.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => api.child.once("exit", resolve)),
    delay(5_000).then(() => api.child.exitCode === null && api.child.kill())
  ]);
}

async function request(baseUrl, pathName, { cookie, headers = {}, method = "GET", origin, payload } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  if (origin) requestHeaders.Origin = origin;
  let body;
  if (payload !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    requestHeaders["X-HahaTalk-Client"] = "web-v1";
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

function responseCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie, "Authentication response did not set a cookie.");
  return setCookie.split(";", 1)[0];
}

async function signup(baseUrl, origin, email, password, displayName, characterId) {
  const result = await request(baseUrl, "/auth/signup", {
    method: "POST",
    origin,
    payload: { characterId, displayName, email, password }
  });
  assert(result.response.status === 201, `Signup failed for ${email}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return { cookie: responseCookie(result.response), publicId: result.body.user.id };
}

async function mutate(baseUrl, origin, cookie, pathName, payload, expected = 201) {
  const result = await request(baseUrl, pathName, { cookie, method: "POST", origin, payload });
  assert(result.response.status === expected, `POST ${pathName} expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function expectStatus(baseUrl, pathName, options, expected) {
  const result = await request(baseUrl, pathName, options);
  assert(result.response.status === expected, `${options.method ?? "GET"} ${pathName} expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function agentPost(baseUrl, pathName, payload, expected, token, marker = false) {
  return expectStatus(baseUrl, pathName, {
    headers: {
      ...(marker ? { "X-HahaTalk-Remote-Agent": "agent-v1" } : {}),
      ...(token ? { "X-HahaTalk-Remote-Agent-Token": token } : {})
    },
    method: "POST",
    payload
  }, expected);
}

async function seedCall(database, callId, participantRows, screenOwnerInternalId = undefined, spaceId = hubId) {
  await database.query(
    `insert into call_sessions (
       id, organization_id, space_id, created_by, call_type, provider_room_name,
       status, expires_at, started_at
     ) values ($1, $2, $3, $4, 'video', $5, 'active', now() + interval '2 hours', now())`,
    [callId, organizationId, spaceId, participantRows[0].internalId, `hht_call_stage9_${callId.replaceAll("-", "")}`]
  );
  for (const [index, participant] of participantRows.entries()) {
    const shares = participant.internalId === screenOwnerInternalId;
    await database.query(
      `insert into call_participants (
         call_session_id, user_id, role, status, provider_identity,
         can_publish_audio, can_publish_video, joined_at,
         screen_share_status, screen_share_requested_at, screen_share_started_at
       ) values ($1, $2, $3, 'joined', $4, true, true, now(), $5, $6, $6)`,
      [
        callId,
        participant.internalId,
        index === 0 ? "host" : "participant",
        `hht_media_stage9_${callId.replaceAll("-", "")}_${index}`,
        shares ? "active" : "off",
        shares ? new Date() : null
      ]
    );
  }
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

  const owner = await signup(baseUrl, origin, "you@inviz.co.kr", "Stage9!OwnerPass", "Stage9 Owner", "char-calm-lead");
  const mina = await signup(baseUrl, origin, "mina@inviz.co.kr", "Stage9!MinaPass", "Stage9 Mina", "char-focus-maker");
  const jun = await signup(baseUrl, origin, "jun@inviz.co.kr", "Stage9!JunPass", "Stage9 Jun", "char-calm-lead");
  const guest = await signup(baseUrl, origin, "hana.customer@example.com", "Stage9!GuestPass", "Stage9 Guest", "char-customer-guest");
  assert(owner.publicId === users.owner.publicId && mina.publicId === users.mina.publicId, "Seed user claims returned unexpected public IDs.");

  const capabilities = await expectStatus(baseUrl, "/remote-support/capabilities", { cookie: owner.cookie }, 200);
  assert(capabilities.controlPlaneAvailable && capabilities.agent.mode === "dry_run", "Remote support control plane capability is incorrect.");
  assert(!capabilities.agent.nativeInputAvailable && !capabilities.scopes.clipboard.available, "Unsigned native or clipboard capability was not fail-closed.");

  const callA = randomUUID();
  await seedCall(database, callA, [users.owner, users.mina], users.mina.internalId);
  await expectStatus(baseUrl, "/remote-support", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: {
      callId: callA,
      clientRequestId: `remote-unavailable-${randomUUID()}`,
      requestedScopes: ["screen_view", "clipboard"],
      spaceId: hubId,
      targetUserId: users.mina.publicId
    }
  }, 400);

  const session = await mutate(baseUrl, origin, owner.cookie, "/remote-support", {
    callId: callA,
    clientRequestId: `remote-request-${randomUUID()}`,
    requestedScopes: ["screen_view", "remote_control"],
    spaceId: hubId,
    targetUserId: users.mina.publicId
  });
  assert(session.status === "requested" && session.consents.length === 2, "Remote support consent rows were not created.");
  await expectStatus(baseUrl, `/remote-support/${session.id}`, { cookie: jun.cookie }, 404);
  const junVisible = await expectStatus(baseUrl, `/remote-support?spaceId=${hubId}`, { cookie: jun.cookie }, 200);
  assert(junVisible.length === 0, "Remote support session leaked to a non-participant.");

  const callConcurrent = randomUUID();
  await seedCall(database, callConcurrent, [users.jun, users.mina], users.mina.internalId, groupId);
  await expectStatus(baseUrl, "/remote-support", {
    cookie: jun.cookie,
    method: "POST",
    origin,
    payload: {
      callId: callConcurrent,
      clientRequestId: `remote-concurrent-${randomUUID()}`,
      requestedScopes: ["screen_view", "remote_control"],
      spaceId: groupId,
      targetUserId: users.mina.publicId
    }
  }, 409);

  const chat = await mutate(baseUrl, origin, owner.cookie, "/messages", {
    audienceType: "selected",
    body: "원격 지원 동의 대기 중에도 채팅은 계속됩니다.",
    clientMessageId: `stage9-chat-${randomUUID()}`,
    requiresConfirmation: false,
    spaceId: hubId,
    targetUserIds: [users.mina.publicId]
  });
  assert(chat.message.body.includes("채팅은 계속"), "Remote support control state blocked ordinary chat.");

  await expectStatus(baseUrl, `/remote-support/${session.id}/consents`, {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { decision: "granted", policyVersion: capabilities.policyVersion, scope: "screen_view" }
  }, 403);
  const oneConsent = await mutate(baseUrl, origin, mina.cookie, `/remote-support/${session.id}/consents`, {
    decision: "granted",
    policyVersion: capabilities.policyVersion,
    scope: "screen_view"
  }, 200);
  assert(oneConsent.status === "requested", "Session approved before every requested scope was granted.");
  const approved = await mutate(baseUrl, origin, mina.cookie, `/remote-support/${session.id}/consents`, {
    decision: "granted",
    policyVersion: capabilities.policyVersion,
    scope: "remote_control"
  }, 200);
  assert(approved.status === "approved" && approved.canActivateAgent, "Target approval did not unlock agent activation.");
  await expectStatus(baseUrl, `/remote-support/${session.id}/agent-activation`, {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: {}
  }, 403);

  const activation = await mutate(baseUrl, origin, mina.cookie, `/remote-support/${session.id}/agent-activation`, {});
  assert(activation.activationSecret.length >= 40 && activation.agentMode === "dry_run", "One-time activation secret was not issued.");
  const activationDigest = await database.query(
    `select octet_length(token_digest) as digest_length
     from remote_support_agent_credentials where session_id = $1 and credential_kind = 'activation'`,
    [session.id]
  );
  assert(Number(activationDigest.rows[0]?.digest_length) === 32, "Activation credential was not stored as a SHA-256 digest.");

  const activationPayload = {
    activationSecret: activation.activationSecret,
    agentInstanceId: `hht_agent_${randomUUID()}`,
    agentVersion: "0.15.0-test",
    deviceId: `hht_device_${randomUUID()}`,
    platform: "win32"
  };
  await agentPost(baseUrl, "/internal/remote-support/activate", activationPayload, 403, undefined, false);
  const credential = await agentPost(baseUrl, "/internal/remote-support/activate", activationPayload, 201, undefined, true);
  assert(credential.agentToken.length >= 40 && credential.controlEpoch === 1, "Agent bearer credential was not issued.");
  await agentPost(baseUrl, "/internal/remote-support/activate", activationPayload, 401, undefined, true);
  await agentPost(baseUrl, `/internal/remote-support/sessions/${session.id}/commands/claim`, {}, 401, "invalid-agent-token");

  await expectStatus(baseUrl, `/remote-support/${session.id}/commands`, {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { clientCommandId: `invalid-key-${randomUUID()}`, kind: "key", payload: { action: "press", code: "MetaLeft" } }
  }, 400);
  const commandKey = `remote-command-${randomUUID()}`;
  const command = await mutate(baseUrl, origin, owner.cookie, `/remote-support/${session.id}/commands`, {
    clientCommandId: commandKey,
    kind: "pointer_move",
    payload: { x: 0.50001, y: 0.25 }
  });
  assert(command.payload.x === 0.5 && command.status === "queued", "Pointer command was not normalized and queued.");
  const replay = await mutate(baseUrl, origin, owner.cookie, `/remote-support/${session.id}/commands`, {
    clientCommandId: commandKey,
    kind: "pointer_move",
    payload: { x: 0.50001, y: 0.25 }
  });
  assert(replay.id === command.id, "Command idempotency replay created a duplicate command.");
  await expectStatus(baseUrl, `/remote-support/${session.id}/commands`, {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { clientCommandId: commandKey, kind: "pointer_move", payload: { x: 0.2, y: 0.2 } }
  }, 409);

  validateCommand(command, 1);
  let localValidationRejected = false;
  try {
    validateCommand({ ...command, controlEpoch: 99 }, 1);
  } catch {
    localValidationRejected = true;
  }
  assert(localValidationRejected, "Desktop agent accepted a stale control epoch.");

  const claimed = await agentPost(
    baseUrl,
    `/internal/remote-support/sessions/${session.id}/commands/claim`,
    {},
    200,
    credential.agentToken
  );
  assert(claimed.commands.length === 1 && claimed.commands[0].id === command.id, "Agent did not claim the queued command in sequence.");
  const duplicateClaim = await agentPost(
    baseUrl,
    `/internal/remote-support/sessions/${session.id}/commands/claim`,
    {},
    200,
    credential.agentToken
  );
  assert(duplicateClaim.commands.length === 0, "Claimed command was replayed to the agent.");
  await agentPost(
    baseUrl,
    `/internal/remote-support/sessions/${session.id}/commands/${command.id}/complete`,
    { outcome: "executed", resultCode: "unexpected_native_input" },
    400,
    credential.agentToken
  );
  const completed = await agentPost(
    baseUrl,
    `/internal/remote-support/sessions/${session.id}/commands/${command.id}/complete`,
    { outcome: "simulated", resultCode: "unsigned_agent_dry_run" },
    200,
    credential.agentToken
  );
  assert(completed.status === "simulated", "Dry-run agent completion was not persisted.");

  const expiring = await mutate(baseUrl, origin, owner.cookie, `/remote-support/${session.id}/commands`, {
    clientCommandId: `expiring-${randomUUID()}`,
    kind: "wheel",
    payload: { deltaX: 0, deltaY: 120 }
  });
  await database.query(
    `update remote_support_commands
     set created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
     where id = $1`,
    [expiring.id]
  );
  const afterExpiryClaim = await agentPost(
    baseUrl,
    `/internal/remote-support/sessions/${session.id}/commands/claim`,
    {},
    200,
    credential.agentToken
  );
  assert(afterExpiryClaim.commands.length === 0, "Expired command reached the agent.");
  const expiredCommand = await database.query("select status from remote_support_commands where id = $1", [expiring.id]);
  assert(expiredCommand.rows[0]?.status === "expired", "Expired command was not finalized.");

  const cancelled = await mutate(baseUrl, origin, owner.cookie, `/remote-support/${session.id}/commands`, {
    clientCommandId: `cancelled-${randomUUID()}`,
    kind: "key",
    payload: { action: "press", code: "Escape" }
  });
  const paused = await mutate(baseUrl, origin, mina.cookie, `/remote-support/${session.id}/pause`, {}, 200);
  assert(paused.status === "paused" && paused.controlEpoch === 2, "Pause did not increment the control epoch.");
  const cancelledRow = await database.query("select status from remote_support_commands where id = $1", [cancelled.id]);
  assert(cancelledRow.rows[0]?.status === "cancelled", "Pause did not cancel pending commands.");
  await agentPost(baseUrl, `/internal/remote-support/sessions/${session.id}/commands/claim`, {}, 401, credential.agentToken);

  const resumed = await mutate(baseUrl, origin, mina.cookie, `/remote-support/${session.id}/resume`, {}, 200);
  assert(resumed.status === "approved" && resumed.controlEpoch === 2, "Resume did not require a fresh agent activation.");
  const activation2 = await mutate(baseUrl, origin, mina.cookie, `/remote-support/${session.id}/agent-activation`, {});
  const credential2 = await agentPost(baseUrl, "/internal/remote-support/activate", {
    ...activationPayload,
    activationSecret: activation2.activationSecret,
    agentInstanceId: `hht_agent_${randomUUID()}`
  }, 201, undefined, true);
  assert(credential2.controlEpoch === 2, "Fresh agent credential did not bind to the new control epoch.");

  await stopApi(api);
  api = await startApi(port, origin);
  const persisted = await expectStatus(baseUrl, `/remote-support/${session.id}`, { cookie: owner.cookie }, 200);
  assert(persisted.status === "active" && persisted.controlEpoch === 2, "Active remote support state did not survive API restart.");
  await agentPost(baseUrl, `/internal/remote-support/sessions/${session.id}/heartbeat`, {}, 200, credential2.agentToken);

  const revoked = await mutate(baseUrl, origin, mina.cookie, `/remote-support/${session.id}/emergency-stop`, {}, 200);
  assert(revoked.status === "revoked" && revoked.controlEpoch === 3, "Emergency stop did not revoke the session and increment epoch.");
  await agentPost(baseUrl, `/internal/remote-support/sessions/${session.id}/commands/claim`, {}, 401, credential2.agentToken);
  await expectStatus(baseUrl, `/remote-support/${session.id}/commands`, {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { clientCommandId: `after-stop-${randomUUID()}`, kind: "key", payload: { action: "press", code: "Enter" } }
  }, 409);

  const leakedSecret = await database.query(
    `select count(*)::text as count from (
       select metadata_json::text as value from remote_support_events
       union all
       select metadata_json::text from audit_logs where target_type = 'remote_support_session'
     ) records where value like '%' || $1 || '%' or value like '%' || $2 || '%'`,
    [activation.activationSecret, credential.agentToken]
  );
  assert(leakedSecret.rows[0]?.count === "0", "Remote support plaintext credentials leaked into events or audit logs.");

  const guestCall = randomUUID();
  await seedCall(database, guestCall, [users.owner, users.guest], users.guest.internalId);
  await expectStatus(baseUrl, "/remote-support", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: {
      callId: guestCall,
      clientRequestId: `guest-target-${randomUUID()}`,
      requestedScopes: ["screen_view"],
      spaceId: hubId,
      targetUserId: guest.publicId
    }
  }, 403);

  const multiCall = randomUUID();
  await seedCall(database, multiCall, [users.owner, users.mina, users.jun], users.mina.internalId);
  await expectStatus(baseUrl, "/remote-support", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: {
      callId: multiCall,
      clientRequestId: `multi-party-${randomUUID()}`,
      requestedScopes: ["screen_view"],
      spaceId: hubId,
      targetUserId: users.mina.publicId
    }
  }, 403);

  const noScreenCall = randomUUID();
  await seedCall(database, noScreenCall, [users.owner, users.mina]);
  await expectStatus(baseUrl, "/remote-support", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: {
      callId: noScreenCall,
      clientRequestId: `no-screen-${randomUUID()}`,
      requestedScopes: ["screen_view"],
      spaceId: hubId,
      targetUserId: users.mina.publicId
    }
  }, 409);

  const expiringCall = randomUUID();
  await seedCall(database, expiringCall, [users.owner, users.mina], users.mina.internalId);
  const expiringSession = await mutate(baseUrl, origin, owner.cookie, "/remote-support", {
    callId: expiringCall,
    clientRequestId: `expiring-session-${randomUUID()}`,
    requestedScopes: ["screen_view", "remote_control"],
    spaceId: hubId,
    targetUserId: users.mina.publicId
  });
  await mutate(baseUrl, origin, mina.cookie, `/remote-support/${expiringSession.id}/consents`, {
    decision: "granted",
    policyVersion: capabilities.policyVersion,
    scope: "screen_view"
  }, 200);
  await mutate(baseUrl, origin, mina.cookie, `/remote-support/${expiringSession.id}/consents`, {
    decision: "granted",
    policyVersion: capabilities.policyVersion,
    scope: "remote_control"
  }, 200);
  const expiringActivation = await mutate(
    baseUrl,
    origin,
    mina.cookie,
    `/remote-support/${expiringSession.id}/agent-activation`,
    {}
  );
  const expiringCredential = await agentPost(baseUrl, "/internal/remote-support/activate", {
    activationSecret: expiringActivation.activationSecret,
    agentInstanceId: `hht_agent_${randomUUID()}`,
    agentVersion: "0.16.0-test",
    deviceId: `hht_device_${randomUUID()}`,
    platform: "win32"
  }, 201, undefined, true);
  await database.query(
    `update remote_support_sessions
     set requested_at = now() - interval '2 seconds', idle_expires_at = now() - interval '1 second'
     where id = $1`,
    [expiringSession.id]
  );
  const expiredHeartbeat = await agentPost(
    baseUrl,
    `/internal/remote-support/sessions/${expiringSession.id}/heartbeat`,
    {},
    200,
    expiringCredential.agentToken
  );
  assert(
    expiredHeartbeat.sessionStatus === "expired" && expiredHeartbeat.controlEpoch === 2,
    `The remote agent did not enforce the idle timeout and control epoch fence: ${JSON.stringify(expiredHeartbeat)}`
  );
  await agentPost(
    baseUrl,
    `/internal/remote-support/sessions/${expiringSession.id}/commands/claim`,
    {},
    401,
    expiringCredential.agentToken
  );
  const expiredSession = await expectStatus(baseUrl, `/remote-support/${expiringSession.id}`, { cookie: owner.cookie }, 200);
  assert(expiredSession.status === "expired" && expiredSession.controlEpoch === 2, "Idle timeout did not terminate and fence the session.");

  const storage = await database.query(
    `select
       (select count(*) from remote_support_events where session_id = $1) as event_count,
       (select count(*) from audit_logs where target_type = 'remote_support_session' and target_id = $1) as audit_count,
       (select count(distinct payload_json ->> 'recipientInternalId') from outbox_events where aggregate_type = 'remote_support' and aggregate_id = $1) as recipient_count`,
    [session.id]
  );
  assert(Number(storage.rows[0]?.event_count) >= 10, "Remote support lifecycle events are incomplete.");
  assert(Number(storage.rows[0]?.audit_count) >= 8, "Remote support audit trail is incomplete.");
  assert(Number(storage.rows[0]?.recipient_count) === 2, "Remote support realtime projection escaped the two participants.");

  console.log("Consented remote support integration passed: private two-person screen context, scope consent, one-time activation, digest-only credentials, dry-run agent, command allowlist/idempotency/TTL, epoch fencing, pause/resume/emergency stop, restart recovery, guest/multiparty denial, agent-enforced idle expiry, audit, and chat independence are verified.");
} catch (error) {
  if (api?.logs?.length) console.error(api.logs.join(""));
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
