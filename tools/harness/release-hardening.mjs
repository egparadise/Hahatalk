import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

const root = process.cwd();
const apiEntry = path.join(root, "apps", "api", "dist", "main.js");
const migrationsDirectory = path.join(root, "apps", "api", "migrations");
const postgresBin = path.join(root, "apps", "desktop", "runtime", "postgres", "bin");
const pgDump = existsSync(path.join(postgresBin, "pg_dump.exe")) ? path.join(postgresBin, "pg_dump.exe") : "pg_dump";
const pgRestore = existsSync(path.join(postgresBin, "pg_restore.exe")) ? path.join(postgresBin, "pg_restore.exe") : "pg_restore";
const baseDatabaseUrl = process.env.DATABASE_URL
  ?? "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const suffix = `${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const databaseName = `hahatalk_release_${suffix}`;
const restoreDatabaseName = `hahatalk_restore_${suffix}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const restoreUrl = new URL(baseDatabaseUrl);
restoreUrl.pathname = `/${restoreDatabaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = `hahatalk_release_${randomUUID().slice(0, 8)}`;
const metricsToken = `hht_ops_${randomBytes(32).toString("base64url")}`;
const objectRoot = path.join(root, "node_modules", ".cache", `hahatalk-release-${suffix}`);
const ownerId = "00000000-0000-4000-8000-000000000101";
const adminId = "00000000-0000-4000-8000-000000000102";
const memberId = "00000000-0000-4000-8000-000000000103";

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
      AUDIT_EXPORT_TTL_MINUTES: "5",
      DATABASE_URL: databaseUrl,
      HAHATALK_ALLOW_OPEN_SIGNUP: "true",
      HAHATALK_DESTRUCTIVE_LIFECYCLE_ENABLED: "true",
      HAHATALK_MIGRATIONS_DIR: migrationsDirectory,
      HAHATALK_OBJECT_ROOT: objectRoot,
      NODE_ENV: "test",
      OPS_METRICS_TOKEN: metricsToken,
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
    if (child.exitCode !== null) throw new Error(`Release API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ops/health/ready`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // Fresh migrations can take several seconds on Windows.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Release API did not become ready.\n${logs.join("")}`);
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
  if (origin) {
    requestHeaders.Origin = origin;
    requestHeaders["X-HahaTalk-Client"] ??= "web-v1";
  }
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
  return result;
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  assert(value, "Authentication response did not set a cookie.");
  return value.split(";", 1)[0];
}

async function signup(baseUrl, origin, email, password, displayName, characterId) {
  const result = await expectStatus(baseUrl, "/auth/signup", {
    headers: { "X-HahaTalk-Client": "web-v1" },
    method: "POST",
    origin,
    payload: { characterId, displayName, email, password }
  }, 201);
  return { cookie: cookieFrom(result.response), state: result.body };
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      const text = output.join("");
      if (code === 0) resolve(text);
      else reject(new Error(`${command} exited ${code}.\n${text}`));
    });
  });
}

async function databaseInvariants(client) {
  const result = await client.query(`
    select json_build_object(
      'organizations', (select count(*) from organizations),
      'users', (select count(*) from users),
      'audit_logs', (select count(*) from audit_logs),
      'schema_migrations', (select count(*) from schema_migrations),
      'release_candidates', (select count(*) from release_candidates),
      'lifecycle_jobs', (select count(*) from data_lifecycle_jobs),
      'rls_policies', (select count(*) from pg_policies where schemaname = 'public' and policyname like '%_org_isolation')
    ) as value
  `);
  return result.rows[0].value;
}

const adminDatabase = new Client({ connectionString: adminUrl.toString() });
const database = new Client({ connectionString: databaseUrl });
let adminConnected = false;
let databaseConnected = false;
let api;
let rlsRole;
let temporaryRoot;

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

  const owner = await signup(baseUrl, origin, "you@inviz.co.kr", "Stage11!OwnerPass", "Stage11 Owner", "char-calm-lead");
  const admin = await signup(baseUrl, origin, "mina@inviz.co.kr", "Stage11!AdminPass", "Stage11 Admin", "char-focus-maker");
  const member = await signup(baseUrl, origin, "jun@inviz.co.kr", "Stage11!MemberPass", "Stage11 Member", "char-calm-lead");
  assert(owner.state.user.id === "user-you" && admin.state.user.id === "user-mina" && member.state.user.id === "user-jun", "Seed user identity changed.");
  await database.query(
    "update organization_memberships set role = 'admin' where user_id = $1 and organization_id = $2",
    [adminId, owner.state.user.organizationId]
  );

  await expectStatus(baseUrl, "/ops/health/live", {}, 200);
  const readiness = await expectStatus(baseUrl, "/ops/health/ready", {}, 200);
  assert(readiness.body.schema === "016_release_hardening_lifecycle_concurrency.sql", "Readiness did not report the latest hardening schema.");
  await expectStatus(baseUrl, "/ops/metrics", {}, 401);

  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const result = await request(baseUrl, "/auth/login", {
      headers: { "X-HahaTalk-Client": "web-v1" },
      method: "POST",
      origin,
      payload: { email: "you@inviz.co.kr", password: "Wrong-Stage11-Password" }
    });
    const expected = attempt <= 8 ? 401 : 429;
    assert(result.response.status === expected, `Login limiter attempt ${attempt} expected ${expected}, got ${result.response.status}.`);
  }
  await stopApi(api);
  api = await startApi(port, origin);
  await expectStatus(baseUrl, "/auth/login", {
    headers: { "X-HahaTalk-Client": "web-v1" },
    method: "POST",
    origin,
    payload: { email: "you@inviz.co.kr", password: "Wrong-Stage11-Password" }
  }, 429);

  await database.query(
    `insert into audit_logs (
       organization_id, actor_id, action, target_type, target_id, metadata_json
     ) values ($1, $2, 'security.secret_fixture', 'user', $3, $4::jsonb)`,
    [
      owner.state.user.organizationId,
      ownerId,
      memberId,
      JSON.stringify({ messageBody: "STAGE11_TOP_SECRET", participants: [ownerId, memberId], result: "passed", token: "do-not-export" })
    ]
  );
  const exportResult = await expectStatus(baseUrl, "/ops/audit-exports", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: {
      actionPrefix: "security.",
      fromAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      idempotencyKey: `audit-${randomUUID()}`,
      toAt: new Date().toISOString()
    }
  }, 201);
  assert(exportResult.body.status === "completed" && exportResult.body.downloadAvailable, "Audit export did not complete.");
  await expectStatus(baseUrl, "/ops/audit-exports", {
    cookie: member.cookie,
    method: "POST",
    origin,
    payload: {
      fromAt: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: `denied-${randomUUID()}`,
      toAt: new Date().toISOString()
    }
  }, 403);
  const downloaded = await expectStatus(
    baseUrl,
    `/ops/audit-exports/${exportResult.body.id}/download`,
    { cookie: owner.cookie, origin },
    200
  );
  const exportedText = typeof downloaded.body === "string" ? downloaded.body : JSON.stringify(downloaded.body);
  for (const forbidden of ["STAGE11_TOP_SECRET", "do-not-export", ownerId, memberId, "you@inviz.co.kr"]) {
    assert(!exportedText.includes(forbidden), `Audit export leaked forbidden value: ${forbidden}`);
  }
  assert(exportedText.includes("[redacted]") && exportedText.includes("security.secret_fixture"), "Audit export redaction evidence is missing.");

  const policies = await expectStatus(baseUrl, "/ops/retention-policies", { cookie: owner.cookie, origin }, 200);
  assert(Array.isArray(policies.body) && policies.body.length === 6, "Retention policy defaults are incomplete.");
  const extraOrganizationId = randomUUID();
  await database.query("insert into organizations(id, name, plan) values ($1, 'Stage11 Extra Membership', 'business')", [extraOrganizationId]);
  await database.query(
    `insert into organization_memberships(organization_id, user_id, role, status, joined_at)
     values ($1, $2, 'member', 'active', now())`,
    [extraOrganizationId, memberId]
  );
  await expectStatus(baseUrl, "/ops/lifecycle-jobs", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { dryRun: false, idempotencyKey: `multi-org-delete-${randomUUID()}`, jobType: "user_deletion", targetUserId: memberId }
  }, 409);
  await database.query("delete from organizations where id = $1", [extraOrganizationId]);
  const hold = await expectStatus(baseUrl, "/ops/legal-holds", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { dataClass: "user_account", reasonCode: "stage11_test_hold", scopeId: memberId, scopeType: "user" }
  }, 201);
  const deletion = await expectStatus(baseUrl, "/ops/lifecycle-jobs", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { dryRun: false, idempotencyKey: `delete-${randomUUID()}`, jobType: "user_deletion", targetUserId: memberId }
  }, 201);
  assert(deletion.body.status === "blocked" && deletion.body.failureCode === "legal_hold_active", "Legal hold did not block deletion request.");
  await expectStatus(baseUrl, `/ops/lifecycle-jobs/${deletion.body.id}/approve`, {
    cookie: admin.cookie,
    method: "POST",
    origin
  }, 409);
  await expectStatus(baseUrl, `/ops/legal-holds/${hold.body.id}/release`, {
    cookie: owner.cookie,
    method: "POST",
    origin
  }, 200);
  await expectStatus(baseUrl, `/ops/lifecycle-jobs/${deletion.body.id}/approve`, {
    cookie: owner.cookie,
    method: "POST",
    origin
  }, 409);
  const approvedDeletion = await expectStatus(baseUrl, `/ops/lifecycle-jobs/${deletion.body.id}/approve`, {
    cookie: admin.cookie,
    method: "POST",
    origin
  }, 200);
  assert(approvedDeletion.body.status === "approved", "Second administrator did not approve deletion.");
  const racedOrganizationId = randomUUID();
  await database.query("insert into organizations(id, name, plan) values ($1, 'Stage11 Raced Membership', 'business')", [racedOrganizationId]);
  await database.query(
    `insert into organization_memberships(organization_id, user_id, role, status, joined_at)
     values ($1, $2, 'member', 'active', now())`,
    [racedOrganizationId, memberId]
  );
  await expectStatus(baseUrl, `/ops/lifecycle-jobs/${deletion.body.id}/execute`, {
    cookie: owner.cookie,
    method: "POST",
    origin
  }, 409);
  await database.query("delete from organizations where id = $1", [racedOrganizationId]);
  const completedDeletion = await expectStatus(baseUrl, `/ops/lifecycle-jobs/${deletion.body.id}/execute`, {
    cookie: owner.cookie,
    method: "POST",
    origin
  }, 200);
  assert(completedDeletion.body.status === "completed" && completedDeletion.body.result.userAnonymized === 1, "User deletion did not complete.");
  const deletedUser = await database.query("select email::text, display_name, status, password_hash from users where id = $1", [memberId]);
  assert(
    deletedUser.rows[0]?.status === "deleted"
      && deletedUser.rows[0]?.display_name === "Deleted user"
      && deletedUser.rows[0]?.password_hash === null
      && String(deletedUser.rows[0]?.email).endsWith("@invalid.hahatalk"),
    "User deletion did not anonymize credentials and profile identity."
  );

  const dryRun = await expectStatus(baseUrl, "/ops/lifecycle-jobs", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { dryRun: true, idempotencyKey: `dry-${randomUUID()}`, jobType: "operational_cleanup" }
  }, 201);
  const completedDryRun = await expectStatus(baseUrl, `/ops/lifecycle-jobs/${dryRun.body.id}/execute`, {
    cookie: owner.cookie,
    method: "POST",
    origin
  }, 200);
  assert(completedDryRun.body.status === "completed" && completedDryRun.body.dryRun, "Lifecycle dry-run did not complete safely.");

  const exportStorage = await database.query(
    "select object_key from audit_export_jobs where id = $1",
    [exportResult.body.id]
  );
  const exportObjectKey = exportStorage.rows[0]?.object_key;
  const exportObjectPath = exportObjectKey ? path.join(objectRoot, ...exportObjectKey.split("/")) : "";
  assert(exportObjectKey && existsSync(exportObjectPath), "Audit export object was not written.");
  const exportContent = await readFile(exportObjectPath);
  await database.query(
    "update audit_export_jobs set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = $1",
    [exportResult.body.id]
  );
  const expiryJob = await expectStatus(baseUrl, "/ops/lifecycle-jobs", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { dryRun: false, idempotencyKey: `expiry-${randomUUID()}`, jobType: "audit_export_expiry" }
  }, 201);
  await expectStatus(baseUrl, "/ops/lifecycle-jobs", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { dryRun: false, idempotencyKey: `expiry-concurrent-${randomUUID()}`, jobType: "audit_export_expiry" }
  }, 409);
  await expectStatus(baseUrl, `/ops/lifecycle-jobs/${expiryJob.body.id}/approve`, {
    cookie: admin.cookie,
    method: "POST",
    origin
  }, 200);
  await rm(exportObjectPath, { force: true });
  await mkdir(exportObjectPath);
  await writeFile(path.join(exportObjectPath, "delete-blocker"), "force object delete failure", "utf8");
  await expectStatus(baseUrl, `/ops/lifecycle-jobs/${expiryJob.body.id}/execute`, {
    cookie: owner.cookie,
    method: "POST",
    origin
  }, 500);
  const failedExpiry = await expectStatus(baseUrl, `/ops/lifecycle-jobs/${expiryJob.body.id}`, {
    cookie: owner.cookie,
    origin
  }, 200);
  assert(failedExpiry.body.status === "failed" && failedExpiry.body.failureCode === "object_delete_failed", "Object deletion failure was not recorded.");
  const retryableExport = await database.query("select status, object_key from audit_export_jobs where id = $1", [exportResult.body.id]);
  assert(retryableExport.rows[0]?.status === "completed" && retryableExport.rows[0]?.object_key === exportObjectKey, "Failed expiry did not restore retryable export state.");
  await rm(exportObjectPath, { force: true, recursive: true });
  await writeFile(exportObjectPath, exportContent);
  await database.query("update audit_export_jobs set status = 'expired' where id = $1", [exportResult.body.id]);
  await database.query(
    `update data_lifecycle_jobs
     set status = 'running', started_at = now() - interval '10 minutes', completed_at = null, failure_code = null
     where id = $1`,
    [expiryJob.body.id]
  );
  const expired = await expectStatus(baseUrl, `/ops/lifecycle-jobs/${expiryJob.body.id}/execute`, {
    cookie: owner.cookie,
    method: "POST",
    origin
  }, 200);
  assert(expired.body.result.expiredAuditExports === 1, "Audit export expiry count is incorrect.");
  const expiredRow = await database.query("select status, object_key from audit_export_jobs where id = $1", [exportResult.body.id]);
  assert(expiredRow.rows[0]?.status === "expired" && expiredRow.rows[0]?.object_key === null, "Expired audit export retained its object reference.");
  assert(!existsSync(path.join(objectRoot, ...exportObjectKey.split("/"))), "Expired audit export object was not deleted.");

  const digest = createHash("sha256").update("stage11-release-evidence").digest("hex");
  const candidate = await expectStatus(baseUrl, "/ops/release-candidates", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: {
      artifactSha256: digest,
      gitSha: "a7a952bc742a2c35c910189b71df511ec69b8c09",
      manifestSha256: digest,
      schemaVersion: "016_release_hardening_lifecycle_concurrency.sql",
      version: "0.18.0-rc.1"
    }
  }, 201);
  await expectStatus(baseUrl, `/ops/release-candidates/${candidate.body.id}/gates`, {
    cookie: admin.cookie,
    method: "POST",
    origin,
    payload: { detailCode: "missing_evidence_test", gateName: "contracts", result: "passed" }
  }, 409);
  for (const gateName of ["authorization", "backup_restore", "contracts", "dependency_audit", "full_harness", "load_reconnect", "schema", "windows_install"]) {
    await expectStatus(baseUrl, `/ops/release-candidates/${candidate.body.id}/gates`, {
      cookie: admin.cookie,
      method: "POST",
      origin,
      payload: { detailCode: "local_verified", evidenceSha256: digest, gateName, result: "passed" }
    }, 201);
  }
  for (const gateName of ["legal_policy", "media_egress", "mobile_signing", "physical_devices", "production_infrastructure", "windows_signing"]) {
    await expectStatus(baseUrl, `/ops/release-candidates/${candidate.body.id}/gates`, {
      cookie: admin.cookie,
      method: "POST",
      origin,
      payload: { detailCode: "external_evidence_required", gateName, result: "pending_external" }
    }, 201);
  }
  const finalized = await expectStatus(baseUrl, `/ops/release-candidates/${candidate.body.id}/finalize`, {
    cookie: owner.cookie,
    method: "POST",
    origin
  }, 200);
  assert(finalized.body.status === "candidate" && finalized.body.rolloutPercent === 0, "Pending external gates incorrectly approved release.");
  await expectStatus(baseUrl, `/ops/release-candidates/${candidate.body.id}/rollout`, {
    cookie: owner.cookie,
    method: "PATCH",
    origin,
    payload: { rolloutPercent: 1 }
  }, 409);
  const rolledBack = await expectStatus(baseUrl, `/ops/release-candidates/${candidate.body.id}/rollback`, {
    cookie: owner.cookie,
    method: "POST",
    origin
  }, 200);
  assert(rolledBack.body.status === "rolled_back", "Release rollback did not fence the candidate.");

  const secondOrganizationId = randomUUID();
  const secondUserId = randomUUID();
  await database.query("insert into organizations(id, name, plan) values ($1, 'Stage11 Other', 'business')", [secondOrganizationId]);
  await database.query(
    `insert into users(id, public_id, email, display_name, status)
     values ($1, $2, $3, 'Other Owner', 'active')`,
    [secondUserId, `stage11-other-${suffix}`, `stage11-other-${suffix}@example.invalid`]
  );
  await database.query(
    `insert into organization_memberships(organization_id, user_id, role, status, joined_at)
     values ($1, $2, 'owner', 'active', now())`,
    [secondOrganizationId, secondUserId]
  );
  await database.query(
    `insert into audit_export_jobs (
       organization_id, requested_by, idempotency_digest, status, from_at, to_at, failure_code
     ) values ($1, $2, $3, 'failed', now() - interval '1 hour', now(), 'fixture')`,
    [secondOrganizationId, secondUserId, randomBytes(32)]
  );
  rlsRole = `hht_rls_${suffix.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
  await database.query(`create role ${rlsRole} nosuperuser nobypassrls`);
  await database.query(`grant usage on schema public to ${rlsRole}`);
  await database.query(`grant select on audit_export_jobs to ${rlsRole}`);
  await database.query("begin");
  try {
    await database.query(`set local role ${rlsRole}`);
    const noContext = await database.query("select count(*)::int as count from audit_export_jobs");
    assert(noContext.rows[0]?.count === 0, "RLS did not default-deny without organization context.");
    await database.query("select set_config('hahatalk.organization_id', $1, true)", [owner.state.user.organizationId]);
    const ownContext = await database.query("select count(*)::int as count from audit_export_jobs");
    assert(ownContext.rows[0]?.count >= 1, "RLS hid the selected organization.");
    await database.query("select set_config('hahatalk.organization_id', $1, true)", [secondOrganizationId]);
    const otherContext = await database.query("select count(*)::int as count from audit_export_jobs");
    assert(otherContext.rows[0]?.count === 1, "RLS mixed organization rows.");
  } finally {
    await database.query("rollback");
  }

  const metrics = await expectStatus(baseUrl, "/ops/metrics", {
    headers: { "X-HahaTalk-Ops-Token": metricsToken }
  }, 200);
  const metricsText = String(metrics.body);
  assert(metricsText.includes("hahatalk_http_requests_total") && metricsText.includes("hahatalk_operations_total"), "Operational metrics are incomplete.");
  for (const forbidden of [ownerId, adminId, memberId, "you@inviz.co.kr", "STAGE11_TOP_SECRET"]) {
    assert(!metricsText.includes(forbidden), `Metrics leaked high-cardinality/private value: ${forbidden}`);
  }

  await stopApi(api);
  api = undefined;
  const sourceInvariants = await databaseInvariants(database);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "hahatalk-stage11-"));
  const backupPath = path.join(temporaryRoot, "release-hardening.dump");
  await runCommand(pgDump, [
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--file", backupPath,
    databaseUrl
  ], { env: { PGOPTIONS: "-c row_security=off" } });
  assert(existsSync(backupPath) && (await readFile(backupPath)).byteLength > 1_024, "PostgreSQL backup archive is empty.");
  await adminDatabase.query(`create database "${restoreDatabaseName}"`);
  await runCommand(pgRestore, [
    "--exit-on-error",
    "--no-owner",
    "--no-privileges",
    "--dbname", restoreUrl.toString(),
    backupPath
  ]);
  const restored = new Client({ connectionString: restoreUrl.toString() });
  await restored.connect();
  try {
    const restoredInvariants = await databaseInvariants(restored);
    assert(
      JSON.stringify(restoredInvariants) === JSON.stringify(sourceInvariants),
      `Restore invariants differ. source=${JSON.stringify(sourceInvariants)} restored=${JSON.stringify(restoredInvariants)}`
    );
    const latest = await restored.query("select 1 from schema_migrations where version = '016_release_hardening_lifecycle_concurrency.sql'");
    assert(latest.rowCount === 1, "Restored database is missing migration 016.");
  } finally {
    await restored.end();
  }

  console.log("Release hardening integration passed: durable restart-safe throttling, redacted audit export, retention/legal hold/four-eyes deletion, RLS differential isolation, metrics privacy, release rollback, and real pg_dump/pg_restore invariants are verified.");
} finally {
  await stopApi(api).catch(() => undefined);
  if (databaseConnected) {
    if (rlsRole) {
      await database.query(`drop owned by ${rlsRole}`).catch(() => undefined);
      await database.query(`drop role if exists ${rlsRole}`).catch(() => undefined);
    }
    await database.end().catch(() => undefined);
  }
  if (adminConnected) {
    await adminDatabase.query(`drop database if exists "${restoreDatabaseName}" with (force)`).catch(() => undefined);
    await adminDatabase.query(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined);
    await adminDatabase.end().catch(() => undefined);
  }
  if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true }).catch(() => undefined);
  await rm(objectRoot, { force: true, recursive: true }).catch(() => undefined);
}
