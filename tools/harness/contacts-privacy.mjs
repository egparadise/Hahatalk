import { randomUUID } from "node:crypto";
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
const databaseName = `hahatalk_contacts_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_contacts_session";
const clientHeader = { "X-HahaTalk-Client": "web-v1" };

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
  let lastHealthError = "not attempted";
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

  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Contacts API exited during startup.\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return { child, logs };
      lastHealthError = `HTTP ${response.status}`;
    } catch (error) {
      lastHealthError = error instanceof Error ? error.message : String(error);
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Contacts API did not become healthy (${lastHealthError}).\n${logs.join("")}`);
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
  if (method !== "GET" && method !== "HEAD") {
    headers.Origin = origin;
    Object.assign(headers, clientHeader);
  }
  if (payload !== undefined) headers["Content-Type"] = "application/json";
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
  assert(result.response.status === 201, `Signup failed for ${email}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return { cookie: responseCookie(result.response), userId: result.body.user.id };
}

async function mutate(baseUrl, webOrigin, cookie, pathName, method, payload, expectedStatus) {
  const result = await request(baseUrl, pathName, { cookie, method, origin: webOrigin, payload });
  assert(
    result.response.status === expectedStatus,
    `${method} ${pathName} returned ${result.response.status}, expected ${expectedStatus}: ${JSON.stringify(result.body)}`
  );
  return result.body;
}

async function dashboard(baseUrl, cookie) {
  const result = await request(baseUrl, "/contacts", { cookie });
  assert(result.response.status === 200, `Contacts dashboard failed: ${result.response.status} ${JSON.stringify(result.body)}`);
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

  const owner = await signup(baseUrl, webOrigin, "you@inviz.co.kr", "Stage4!OwnerPass", "Stage4 Owner", "char-calm-lead");
  const mina = await signup(baseUrl, webOrigin, "mina@inviz.co.kr", "Stage4!MinaPass", "Stage4 Mina", "char-focus-maker");
  const jun = await signup(baseUrl, webOrigin, "jun@inviz.co.kr", "Stage4!JunPass", "Stage4 Jun", "char-calm-lead");
  const hana = await signup(baseUrl, webOrigin, "hana.customer@example.com", "Stage4!HanaPass", "Stage4 Hana", "char-customer-guest");

  const ownerInitial = await dashboard(baseUrl, owner.cookie);
  assert(ownerInitial.canManage && ownerInitial.availablePeople.length === 3, "Owner contact directory is not available.");
  const guestInitial = await dashboard(baseUrl, hana.cookie);
  assert(!guestInitial.canManage && guestInitial.availablePeople.length === 0, "Guest received contact management capability.");
  await mutate(baseUrl, webOrigin, hana.cookie, "/contact-collections", "POST", {
    kind: "custom",
    name: "Guest must not create"
  }, 403);

  const privateMarker = `Stage4 customers ${randomUUID()}`;
  const privateSecret = `private-note-${randomUUID()}`;
  let customer = await mutate(baseUrl, webOrigin, owner.cookie, "/contact-collections", "POST", {
    description: "Owner private service contacts",
    kind: "customers",
    name: privateMarker
  }, 201);
  customer = await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${customer.id}/members`, "POST", {
    followUpAt: "2026-08-01T01:00:00.000Z",
    followUpState: "planned",
    label: "VIP customer",
    notes: privateSecret,
    sortOrder: 10,
    tags: ["Priority", "서비스"],
    userId: mina.userId
  }, 201);
  assert(customer.members[0].privateDetails.tags.join(",") === "priority,서비스", "Owner tags were not normalized and persisted.");
  assert(customer.members[0].privateDetails.notes === privateSecret, "Owner private notes were not returned to the owner.");
  customer = await mutate(
    baseUrl,
    webOrigin,
    owner.cookie,
    `/contact-collections/${customer.id}/members/${mina.userId}`,
    "PATCH",
    {
      followUpState: "waiting",
      label: "VIP customer updated",
      notes: privateSecret,
      tags: ["priority", "service-review"]
    },
    200
  );
  assert(customer.members[0].privateDetails.followUpState === "waiting", "Owner follow-up update did not persist.");

  const minaPrivate = await dashboard(baseUrl, mina.cookie);
  const minaPrivateJson = JSON.stringify(minaPrivate);
  assert(!minaPrivateJson.includes(customer.id), "Owner-only collection id leaked to a stored member.");
  assert(!minaPrivateJson.includes(privateMarker), "Owner-only collection name leaked to a stored member.");
  assert(!minaPrivateJson.includes(privateSecret), "Owner-only relationship notes leaked to a stored member.");
  assert(!minaPrivateJson.includes("VIP customer updated"), "Owner-only relationship label leaked to a stored member.");

  const hiddenMutation = await request(baseUrl, `/contact-collections/${customer.id}`, {
    cookie: mina.cookie,
    method: "PATCH",
    origin: webOrigin,
    payload: { name: "Unauthorized rename" }
  });
  const missingMutation = await request(baseUrl, `/contact-collections/${randomUUID()}`, {
    cookie: mina.cookie,
    method: "PATCH",
    origin: webOrigin,
    payload: { name: "Missing rename" }
  });
  assert(hiddenMutation.response.status === 404 && missingMutation.response.status === 404, "Hidden and missing collection errors are distinguishable by status.");
  assert(hiddenMutation.body.message === missingMutation.body.message, "Hidden collection lookup disclosed existence through its error message.");

  const minaOwnedName = `Mina private ${randomUUID()}`;
  await mutate(baseUrl, webOrigin, mina.cookie, "/contact-collections", "POST", {
    kind: "custom",
    name: minaOwnedName
  }, 201);
  const ownerAfterMinaCreate = await dashboard(baseUrl, owner.cookie);
  assert(!JSON.stringify(ownerAfterMinaCreate).includes(minaOwnedName), "Another owner's private collection leaked through organization role.");
  await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${customer.id}/policy`, "POST", {
    rosterVisibility: "shared",
    visibility: "shared"
  }, 400);

  const familyOriginalName = `Stage4 family ${randomUUID()}`;
  const familyDescription = "동의한 가족만 서로의 이름을 봅니다.";
  let family = await mutate(baseUrl, webOrigin, owner.cookie, "/contact-collections", "POST", {
    description: familyDescription,
    kind: "family",
    name: familyOriginalName
  }, 201);
  family = await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}/members`, "POST", {
    label: "private family label",
    notes: "Mina private family notes",
    tags: ["family-private"],
    userId: mina.userId
  }, 201);
  family = await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}/members`, "POST", {
    notes: "Jun private family notes",
    userId: jun.userId
  }, 201);
  assert((await dashboard(baseUrl, mina.cookie)).consentRequests.length === 0, "Owner-only family emitted a consent request.");

  family = await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}/policy`, "POST", {
    rosterVisibility: "shared",
    visibility: "shared"
  }, 201);
  assert(family.policyVersion === 2, "Initial family sharing did not create policy version 2.");
  const minaPending = await dashboard(baseUrl, mina.cookie);
  assert(minaPending.sharedCollections.length === 0 && minaPending.consentRequests.length === 1, "Pending consent exposed a shared collection.");
  assert(minaPending.consentRequests[0].collectionName === familyOriginalName, "Consent request omitted the explicitly shared collection name.");
  assert(minaPending.consentRequests[0].collectionDescription === familyDescription, "Consent request omitted the sharing description.");
  const minaPendingJson = JSON.stringify(minaPending.consentRequests[0]);
  assert(!minaPendingJson.includes(jun.userId), "Pending consent request leaked another member.");
  assert(!minaPendingJson.includes("private family"), "Pending consent request leaked private relationship metadata.");

  await mutate(baseUrl, webOrigin, mina.cookie, `/contact-collections/${family.id}/consent`, "POST", {
    decision: "granted",
    policyVersion: 2
  }, 201);
  let minaShared = await dashboard(baseUrl, mina.cookie);
  assert(minaShared.sharedCollections.length === 1, "Granted member did not receive the shared family projection.");
  assert(minaShared.sharedCollections[0].members.length === 2, "Shared roster exposed a non-consenting member.");
  assert(!JSON.stringify(minaShared.sharedCollections[0]).includes(jun.userId), "Non-consenting member leaked into the roster.");
  assert(!JSON.stringify(minaShared.sharedCollections[0]).includes("privateDetails"), "Owner-private fields leaked into a shared projection.");

  const hanaBeforeTarget = await dashboard(baseUrl, hana.cookie);
  assert(hanaBeforeTarget.sharedCollections.length === 0 && hanaBeforeTarget.consentRequests.length === 0, "Unrelated guest learned about a shared family.");
  await mutate(baseUrl, webOrigin, jun.cookie, `/contact-collections/${family.id}/consent`, "POST", {
    decision: "granted",
    policyVersion: 2
  }, 201);
  minaShared = await dashboard(baseUrl, mina.cookie);
  assert(minaShared.sharedCollections[0].members.some((member) => member.person.id === jun.userId), "Consenting member was absent from the shared roster.");

  await mutate(baseUrl, webOrigin, mina.cookie, `/contact-collections/${family.id}/consent`, "POST", {
    decision: "revoked",
    policyVersion: 2
  }, 201);
  const minaRevoked = await dashboard(baseUrl, mina.cookie);
  assert(minaRevoked.sharedCollections.length === 0 && minaRevoked.consentRequests[0].myDecision === "revoked", "Consent revocation did not hide the shared group immediately.");
  await mutate(baseUrl, webOrigin, mina.cookie, `/contact-collections/${family.id}/consent`, "POST", {
    decision: "granted",
    policyVersion: 2
  }, 201);

  family = await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}/policy`, "POST", {
    rosterVisibility: "owner_only",
    visibility: "shared"
  }, 201);
  assert(family.policyVersion === 3, "Roster policy change did not increment the version.");
  const staleConsent = await request(baseUrl, `/contact-collections/${family.id}/consent`, {
    cookie: mina.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { decision: "granted", policyVersion: 2 }
  });
  assert(staleConsent.response.status === 409, "A stale policy version was accepted.");
  await mutate(baseUrl, webOrigin, mina.cookie, `/contact-collections/${family.id}/consent`, "POST", {
    decision: "granted",
    policyVersion: 3
  }, 201);
  await mutate(baseUrl, webOrigin, jun.cookie, `/contact-collections/${family.id}/consent`, "POST", {
    decision: "granted",
    policyVersion: 3
  }, 201);
  minaShared = await dashboard(baseUrl, mina.cookie);
  assert(minaShared.sharedCollections[0].members.length === 2, "Owner-only roster exposed another consenting member.");
  assert(!JSON.stringify(minaShared.sharedCollections[0]).includes(jun.userId), "Owner-only roster leaked another member.");

  const familyRenamed = `${familyOriginalName} renamed`;
  family = await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}`, "PATCH", {
    name: familyRenamed
  }, 200);
  assert(family.policyVersion === 4, "Renaming a shared collection did not reset consent with a new policy.");
  const afterRename = await dashboard(baseUrl, mina.cookie);
  assert(afterRename.sharedCollections.length === 0 && afterRename.consentRequests[0].collectionName === familyRenamed, "Shared rename did not refresh the consent request.");

  family = await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}/policy`, "POST", {
    rosterVisibility: "shared",
    visibility: "owner_only"
  }, 201);
  assert(family.policyVersion === 5, "Returning to owner-only did not create a policy history row.");
  const hiddenAgain = await dashboard(baseUrl, mina.cookie);
  assert(hiddenAgain.sharedCollections.length === 0 && hiddenAgain.consentRequests.length === 0, "Owner-only switch did not remove every member projection.");

  family = await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}/policy`, "POST", {
    rosterVisibility: "shared",
    visibility: "shared"
  }, 201);
  assert(family.policyVersion === 6, "Re-sharing did not create policy version 6.");
  await mutate(baseUrl, webOrigin, mina.cookie, `/contact-collections/${family.id}/consent`, "POST", {
    decision: "granted",
    policyVersion: 6
  }, 201);
  await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}/members/${mina.userId}`, "DELETE", {}, 200);
  await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}/members`, "POST", {
    userId: mina.userId
  }, 201);
  const readdedMina = await dashboard(baseUrl, mina.cookie);
  assert(readdedMina.sharedCollections.length === 0 && readdedMina.consentRequests.length === 1, "Re-added member inherited consent from an earlier membership period.");

  const duplicateAdds = await Promise.all([
    request(baseUrl, `/contact-collections/${family.id}/members`, {
      cookie: owner.cookie,
      method: "POST",
      origin: webOrigin,
      payload: { userId: hana.userId }
    }),
    request(baseUrl, `/contact-collections/${family.id}/members`, {
      cookie: owner.cookie,
      method: "POST",
      origin: webOrigin,
      payload: { userId: hana.userId }
    })
  ]);
  assert(duplicateAdds.map((entry) => entry.response.status).sort().join(",") === "201,409", "Concurrent duplicate member add was not serialized safely.");
  const hanaTargeted = await dashboard(baseUrl, hana.cookie);
  assert(!hanaTargeted.canManage && hanaTargeted.consentRequests.length === 1, "Explicitly targeted guest did not receive a restricted consent request.");
  await mutate(baseUrl, webOrigin, hana.cookie, `/contact-collections/${family.id}/consent`, "POST", {
    decision: "denied",
    policyVersion: 6
  }, 201);

  const policyRows = await database.query(
    "select version, visibility, roster_visibility from contact_collection_policies where collection_id = $1 order by version",
    [family.id]
  );
  assert(policyRows.rows.length === 6, "Immutable policy history is incomplete.");
  const consentRows = await database.query(
    "select decision, policy_version from contact_collection_consents where collection_id = $1 order by decided_at, id",
    [family.id]
  );
  assert(consentRows.rows.length >= 8, "Append-only consent decision history is incomplete.");
  const auditLeak = await database.query(
    "select count(*)::int as count from audit_logs where metadata_json::text like $1",
    [`%${privateSecret}%`]
  );
  assert(auditLeak.rows[0].count === 0, "Private relationship notes leaked into audit metadata.");

  await stopApi(api);
  api = await startApi(port, webOrigin);
  const ownerAfterRestart = await dashboard(baseUrl, owner.cookie);
  const restoredFamily = ownerAfterRestart.ownedCollections.find((collection) => collection.id === family.id);
  assert(restoredFamily?.policyVersion === 6, "Collection policy history did not survive API restart.");
  const hanaAfterRestart = await dashboard(baseUrl, hana.cookie);
  assert(hanaAfterRestart.consentRequests[0]?.myDecision === "denied", "Guest consent decision did not survive API restart.");

  await mutate(baseUrl, webOrigin, owner.cookie, `/contact-collections/${family.id}`, "DELETE", {}, 200);
  const minaAfterArchive = await dashboard(baseUrl, mina.cookie);
  const hanaAfterArchive = await dashboard(baseUrl, hana.cookie);
  assert(minaAfterArchive.sharedCollections.length === 0 && minaAfterArchive.consentRequests.length === 0, "Archived collection remained visible to a member.");
  assert(hanaAfterArchive.sharedCollections.length === 0 && hanaAfterArchive.consentRequests.length === 0, "Archived collection remained visible to a guest.");

  const auditActions = await database.query(
    `select action, count(*)::int as count
     from audit_logs
     where target_type = 'contact_collection'
     group by action`
  );
  const actions = new Set(auditActions.rows.map((row) => row.action));
  for (const action of [
    "contact_collection.created",
    "contact_collection.member_added",
    "contact_collection.member_updated",
    "contact_collection.member_removed",
    "contact_collection.policy_changed",
    "contact_collection.consent_granted",
    "contact_collection.consent_denied",
    "contact_collection.consent_revoked",
    "contact_collection.archived"
  ]) {
    assert(actions.has(action), `Audit action is missing: ${action}`);
  }

  console.log("Contacts privacy check passed: owner-only non-disclosure, relationship metadata, exact-version consent, shared roster projection, revocation, re-add, concurrency, guest restriction, audit history, restart, and archive.");
} finally {
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
