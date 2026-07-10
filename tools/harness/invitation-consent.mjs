import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

const root = process.cwd();
const apiEntry = path.join(root, "apps", "api", "dist", "main.js");
const migrationsDirectory = path.join(root, "apps", "api", "migrations");
const baseDatabaseUrl = process.env.DATABASE_URL
  ?? "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const databaseName = `hahatalk_invite_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_invitation_session";
const clientHeader = { "X-HahaTalk-Client": "web-v1" };
const ownerEmail = "you@inviz.co.kr";
const ownerPassword = "Stage2B!OwnerPass";
const adminEmail = "mina@inviz.co.kr";
const adminPassword = "Stage2B!AdminPass";

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
      HAHATALK_MIGRATIONS_DIR: migrationsDirectory,
      PORT: String(port),
      SESSION_COOKIE_NAME: cookieName,
      WEB_ORIGIN: webOrigin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`HahaTalk API exited during invitation test startup.\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return { child, logs };
      }
    } catch {
      // Migrations or the listener are still starting.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`HahaTalk invitation API did not become healthy.\n${logs.join("")}`);
}

async function stopApi(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000).then(() => child.exitCode === null && child.kill())
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
    method
  });
  const text = await response.text();
  return { body: text ? JSON.parse(text) : undefined, response };
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
  assert(result.response.status === 201, `Bootstrap signup failed for ${email}: ${result.response.status}.`);
  return responseCookie(result.response);
}

async function login(baseUrl, webOrigin, email, password, expectedStatus = 201) {
  const result = await request(baseUrl, "/auth/login", {
    method: "POST",
    origin: webOrigin,
    payload: { email, password }
  });
  assert(result.response.status === expectedStatus, `Login status for ${email} was ${result.response.status}, expected ${expectedStatus}.`);
  return expectedStatus === 201 ? responseCookie(result.response) : undefined;
}

async function createInvitation(baseUrl, webOrigin, ownerCookie, payload) {
  const result = await request(baseUrl, "/invitations", {
    cookie: ownerCookie,
    method: "POST",
    origin: webOrigin,
    payload
  });
  assert(result.response.status === 201, `Invitation creation failed with ${result.response.status}.`);
  assert(result.body.inviteCode?.startsWith("hti_"), "Invitation raw code was not returned exactly at creation.");
  return result.body;
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

  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const webOrigin = `http://127.0.0.1:${await findAvailablePort()}`;
  api = await startApi(port, webOrigin);

  const ownerCookie = await signup(baseUrl, webOrigin, ownerEmail, ownerPassword, "Stage2B Owner", "char-calm-lead");
  const adminCookie = await signup(baseUrl, webOrigin, adminEmail, adminPassword, "Stage2B Admin", "char-focus-maker");

  const openSignup = await request(baseUrl, "/auth/signup", {
    method: "POST",
    origin: webOrigin,
    payload: {
      characterId: "char-calm-lead",
      displayName: "No Invitation",
      email: "no-invitation@example.test",
      password: "NoInvitation!123"
    }
  });
  assert(openSignup.response.status === 403, "Uninvited arbitrary signup was not denied.");

  const guestEmail = `guest-${randomUUID().slice(0, 8)}@example.test`;
  const guestPassword = "GuestInvite!123";
  const guestInvite = await createInvitation(baseUrl, webOrigin, ownerCookie, {
    approvalPolicy: "owner_and_invitee",
    email: guestEmail,
    role: "guest"
  });
  assert(guestInvite.status === "sent", "Owner-approved invitation did not enter sent state.");
  const digest = createHash("sha256").update(guestInvite.inviteCode).digest("hex");
  const storedToken = await database.query(
    "select encode(token_digest, 'hex') as digest, octet_length(token_digest) as bytes from invitations where id = $1",
    [guestInvite.id]
  );
  assert(storedToken.rows[0]?.bytes === 32, "Invitation digest is not 32 bytes.");
  assert(storedToken.rows[0]?.digest === digest, "Invitation digest does not match the raw code hash.");
  assert(storedToken.rows[0]?.digest !== guestInvite.inviteCode, "Raw invitation code was stored in PostgreSQL.");

  const preview = await request(baseUrl, "/invitations/preview", {
    method: "POST",
    origin: webOrigin,
    payload: { inviteCode: guestInvite.inviteCode }
  });
  assert(preview.response.status === 201, "Valid invitation preview failed.");
  assert(preview.body.emailMasked.includes("@"), "Invitation preview did not mask the invitee email.");
  assert(!JSON.stringify(preview.body).includes(guestInvite.inviteCode), "Invitation preview reflected the raw code.");

  const missingConsent = await request(baseUrl, "/invitations/accept", {
    method: "POST",
    origin: webOrigin,
    payload: {
      acceptGroupJoin: true,
      acceptPrivacy: false,
      acceptTerms: true,
      characterId: "char-customer-guest",
      displayName: "Stage2B Guest",
      inviteCode: guestInvite.inviteCode,
      password: guestPassword
    }
  });
  assert(missingConsent.response.status === 400, "Invitation acceptance without all consent was not denied.");

  const accepted = await request(baseUrl, "/invitations/accept", {
    method: "POST",
    origin: webOrigin,
    payload: {
      acceptGroupJoin: true,
      acceptPrivacy: true,
      acceptTerms: true,
      characterId: "char-customer-guest",
      displayName: "Stage2B Guest",
      inviteCode: guestInvite.inviteCode,
      password: guestPassword
    }
  });
  assert(accepted.response.status === 201 && accepted.body.status === "accepted", "Owner-and-invitee acceptance did not activate membership.");

  const reuse = await request(baseUrl, "/invitations/accept", {
    method: "POST",
    origin: webOrigin,
    payload: {
      acceptGroupJoin: true,
      acceptPrivacy: true,
      acceptTerms: true,
      characterId: "char-customer-guest",
      displayName: "Replay",
      inviteCode: guestInvite.inviteCode,
      password: "ReplayAttempt!123"
    }
  });
  assert(reuse.response.status === 404, "Consumed invitation code was reusable.");

  const guestCookie = await login(baseUrl, webOrigin, guestEmail, guestPassword);
  const guestMe = await request(baseUrl, "/auth/me", { cookie: guestCookie });
  assert(guestMe.body.role === "guest", "Accepted guest did not receive guest role.");
  assert(!guestMe.body.permissions.canInviteGuests, "Guest received invite permission.");
  assert(!guestMe.body.permissions.canDownloadFiles, "Guest received download permission.");
  assert(!guestMe.body.permissions.canUploadFiles, "Guest received upload permission.");
  const guestSnapshot = await request(baseUrl, "/mvp", { cookie: guestCookie });
  assert(guestSnapshot.body.room.mode === "direct" && guestSnapshot.body.users.length === 2, "Guest hub projection disclosed the hidden roster.");
  const guestInvitations = await request(baseUrl, "/invitations", { cookie: guestCookie });
  assert(guestInvitations.response.status === 200 && guestInvitations.body.length === 0, "Guest could enumerate organization invitations.");

  const guestCookieTwo = await login(baseUrl, webOrigin, guestEmail, guestPassword);
  const secondSessions = await request(baseUrl, "/auth/sessions", { cookie: guestCookieTwo });
  const secondCurrent = secondSessions.body.find((session) => session.current);
  assert(secondCurrent, "Second guest session was not listed as current.");
  const firstSessions = await request(baseUrl, "/auth/sessions", { cookie: guestCookie });
  assert(firstSessions.body.length >= 2, "Device session list did not include both logins.");
  const revokeSecond = await request(baseUrl, `/auth/sessions/${secondCurrent.id}/revoke`, {
    cookie: guestCookie,
    method: "POST",
    origin: webOrigin,
    payload: {}
  });
  assert(revokeSecond.response.status === 201, "Another device session could not be revoked.");
  assert((await request(baseUrl, "/auth/me", { cookie: guestCookieTwo })).response.status === 401, "Revoked device session remained active.");
  assert((await request(baseUrl, "/auth/me", { cookie: guestCookie })).response.status === 200, "Current session was revoked with another session.");

  const approvalEmail = `approval-${randomUUID().slice(0, 8)}@example.test`;
  const approvalPassword = "ApprovalGuest!123";
  const approvalInvite = await createInvitation(baseUrl, webOrigin, ownerCookie, {
    approvalPolicy: "admins_and_invitee",
    email: approvalEmail,
    role: "guest"
  });
  assert(approvalInvite.status === "pending_approval" && approvalInvite.requiredApprovalCount === 2, "Admin approval policy was not snapshotted.");
  const pendingAcceptance = await request(baseUrl, "/invitations/accept", {
    method: "POST",
    origin: webOrigin,
    payload: {
      acceptGroupJoin: true,
      acceptPrivacy: true,
      acceptTerms: true,
      characterId: "char-customer-guest",
      displayName: "Approval Guest",
      inviteCode: approvalInvite.inviteCode,
      password: approvalPassword
    }
  });
  assert(pendingAcceptance.body.status === "pending_approval" && !pendingAcceptance.body.loginAllowed, "Invitee bypassed pending manager approval.");
  await login(baseUrl, webOrigin, approvalEmail, approvalPassword, 401);

  const adminInvitations = await request(baseUrl, "/invitations", { cookie: adminCookie });
  const adminApproval = adminInvitations.body.find((invitation) => invitation.id === approvalInvite.id);
  assert(adminApproval?.canDecide, "Required admin did not receive an approval action.");
  assert(!Object.hasOwn(adminApproval, "approvedCount"), "Hidden hub approver received aggregate approval count.");
  assert(!Object.hasOwn(adminApproval, "requiredApprovalCount"), "Hidden hub approver received group approval size.");
  assert(!Object.hasOwn(adminApproval, "approvalPolicy"), "Hidden hub approver received group policy metadata.");

  const approved = await request(baseUrl, `/invitations/${approvalInvite.id}/decision`, {
    cookie: adminCookie,
    method: "POST",
    origin: webOrigin,
    payload: { decision: "approved" }
  });
  assert(approved.response.status === 201 && approved.body.status === "accepted", "Final approval did not activate accepted invitee.");
  await login(baseUrl, webOrigin, approvalEmail, approvalPassword, 201);
  const duplicateApproval = await request(baseUrl, `/invitations/${approvalInvite.id}/decision`, {
    cookie: adminCookie,
    method: "POST",
    origin: webOrigin,
    payload: { decision: "approved" }
  });
  assert(duplicateApproval.response.status === 409, "Approver could submit a second decision.");

  const rejectedInvite = await createInvitation(baseUrl, webOrigin, ownerCookie, {
    approvalPolicy: "admins_and_invitee",
    email: `reject-${randomUUID().slice(0, 8)}@example.test`,
    role: "guest"
  });
  const rejected = await request(baseUrl, `/invitations/${rejectedInvite.id}/decision`, {
    cookie: adminCookie,
    method: "POST",
    origin: webOrigin,
    payload: { decision: "rejected", note: "Relationship not approved" }
  });
  assert(rejected.body.status === "declined", "Impossible approval policy did not decline after rejection.");
  assert((await request(baseUrl, "/invitations/preview", {
    method: "POST",
    origin: webOrigin,
    payload: { inviteCode: rejectedInvite.inviteCode }
  })).response.status === 404, "Rejected invitation code remained available.");

  const quorumInvite = await createInvitation(baseUrl, webOrigin, ownerCookie, {
    approvalPolicy: "quorum_and_invitee",
    email: `quorum-${randomUUID().slice(0, 8)}@example.test`,
    requiredApprovalCount: 1,
    role: "guest"
  });
  assert(quorumInvite.status === "sent", "Satisfied quorum did not enter sent state.");
  const lateDecision = await request(baseUrl, `/invitations/${quorumInvite.id}/decision`, {
    cookie: adminCookie,
    method: "POST",
    origin: webOrigin,
    payload: { decision: "rejected" }
  });
  assert(lateDecision.response.status === 409, "Late rejection changed a completed quorum.");

  const revokedInvite = await createInvitation(baseUrl, webOrigin, ownerCookie, {
    email: `revoked-${randomUUID().slice(0, 8)}@example.test`,
    role: "guest"
  });
  const revoked = await request(baseUrl, `/invitations/${revokedInvite.id}/revoke`, {
    cookie: ownerCookie,
    method: "POST",
    origin: webOrigin,
    payload: {}
  });
  assert(revoked.body.status === "revoked", "Manager revoke did not update invitation status.");

  const expiredInvite = await createInvitation(baseUrl, webOrigin, ownerCookie, {
    email: `expired-${randomUUID().slice(0, 8)}@example.test`,
    expiresInHours: 1,
    role: "guest"
  });
  await database.query(
    "update invitations set token_issued_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where id = $1",
    [expiredInvite.id]
  );
  const expiredPreview = await request(baseUrl, "/invitations/preview", {
    method: "POST",
    origin: webOrigin,
    payload: { inviteCode: expiredInvite.inviteCode }
  });
  assert(expiredPreview.response.status === 410, "Expired invitation did not return Gone.");
  const expiredStored = await database.query("select status, token_digest from invitations where id = $1", [expiredInvite.id]);
  assert(expiredStored.rows[0]?.status === "expired" && expiredStored.rows[0]?.token_digest === null, "Expired invitation was not persisted and scrubbed.");
  const expiredAudit = await database.query(
    "select 1 from audit_logs where target_type = 'membership_invitation' and target_id = $1 and action = 'invitation.expired'",
    [expiredInvite.id]
  );
  assert(expiredAudit.rowCount === 1, "Expired invitation audit was not committed with the Gone response.");

  const concurrentEmail = `concurrent-${randomUUID().slice(0, 8)}@example.test`;
  const concurrentInvite = await createInvitation(baseUrl, webOrigin, ownerCookie, { email: concurrentEmail, role: "guest" });
  const concurrentPayload = {
    acceptGroupJoin: true,
    acceptPrivacy: true,
    acceptTerms: true,
    characterId: "char-customer-guest",
    displayName: "Concurrent Guest",
    inviteCode: concurrentInvite.inviteCode,
    password: "Concurrent!123"
  };
  const concurrentResults = await Promise.all([
    request(baseUrl, "/invitations/accept", { method: "POST", origin: webOrigin, payload: concurrentPayload }),
    request(baseUrl, "/invitations/accept", { method: "POST", origin: webOrigin, payload: concurrentPayload })
  ]);
  const concurrentStatuses = concurrentResults.map((result) => result.response.status).sort();
  assert(concurrentStatuses[0] === 201 && concurrentStatuses[1] === 404, "Concurrent invitation acceptance did not produce exactly one success.");
  const concurrentStored = await database.query("select use_count from invitations where id = $1", [concurrentInvite.id]);
  assert(concurrentStored.rows[0]?.use_count === 1, "Concurrent acceptance incremented invitation use count more than once.");

  const declineInvite = await createInvitation(baseUrl, webOrigin, ownerCookie, {
    email: `decline-${randomUUID().slice(0, 8)}@example.test`,
    role: "guest"
  });
  const declined = await request(baseUrl, "/invitations/decline", {
    method: "POST",
    origin: webOrigin,
    payload: { inviteCode: declineInvite.inviteCode }
  });
  assert(declined.body.status === "declined", "Invitee decline was not recorded.");

  const consentRows = await database.query(
    "select consent_type, decision from consent_records where invitation_id = $1 order by consent_type",
    [guestInvite.id]
  );
  assert(consentRows.rowCount === 3 && consentRows.rows.every((row) => row.decision === "granted"), "Accepted invitation consent evidence is incomplete.");
  const deniedConsent = await database.query(
    "select decision from consent_records where invitation_id = $1 and consent_type = 'group_join'",
    [declineInvite.id]
  );
  assert(deniedConsent.rows[0]?.decision === "denied", "Declined group join consent was not recorded.");
  const auditText = JSON.stringify((await database.query(
    "select action, metadata_json from audit_logs where target_type = 'membership_invitation'"
  )).rows);
  assert(auditText.includes("invitation.created") && auditText.includes("membership.activated"), "Invitation audit timeline is incomplete.");
  assert(!auditText.includes(guestInvite.inviteCode), "Audit log contains a raw invitation code.");

  let rateLimited = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await request(baseUrl, "/invitations/preview", {
      method: "POST",
      origin: webOrigin,
      payload: { inviteCode: `hti_${"x".repeat(43)}` }
    });
    if (result.response.status === 429) {
      rateLimited = true;
      break;
    }
  }
  assert(rateLimited, "Invitation code attempts were not rate limited.");

  console.log("Invitation consent check passed: one-time digest token, approval snapshot/quorum, guest privacy, consent/audit, session revoke, expiry, concurrency, and throttling.");
} finally {
  await stopApi(api?.child);
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
