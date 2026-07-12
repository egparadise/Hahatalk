import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

const root = process.cwd();
const apiEntry = path.join(root, "apps", "api", "dist", "main.js");
const migrationsDirectory = path.join(root, "apps", "api", "migrations");
const baseDatabaseUrl = process.env.DATABASE_URL
  ?? "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const databaseName = `hahatalk_media_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_media_session";
const hubId = "00000000-0000-4000-8000-000000000201";
const objectRoot = await mkdtemp(path.join(os.tmpdir(), "hahatalk-media-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
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
      HAHATALK_OBJECT_ROOT: objectRoot,
      PORT: String(port),
      SESSION_COOKIE_NAME: cookieName,
      WEB_ORIGIN: webOrigin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Media API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // Migrations and the listener are still starting.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Media API did not become healthy.\n${logs.join("")}`);
}

async function stopApi(api) {
  if (!api?.child || api.child.exitCode !== null) return;
  api.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => api.child.once("exit", resolve)),
    delay(5_000).then(() => api.child.exitCode === null && api.child.kill())
  ]);
}

async function jsonRequest(baseUrl, pathName, { cookie, method = "GET", origin, payload } = {}) {
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
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { body, response };
}

async function rawRequest(baseUrl, pathName, { body, cookie, headers = {}, method = "GET", origin } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  if (origin) requestHeaders.Origin = origin;
  if (!["GET", "HEAD"].includes(method)) requestHeaders["X-HahaTalk-Client"] = "web-v1";
  return fetch(`${baseUrl}${pathName}`, {
    body,
    headers: requestHeaders,
    method,
    signal: AbortSignal.timeout(30_000)
  });
}

function responseCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie, "Authentication response did not set a cookie.");
  return setCookie.split(";", 1)[0];
}

async function signup(baseUrl, webOrigin, email, password, displayName, characterId) {
  const result = await jsonRequest(baseUrl, "/auth/signup", {
    method: "POST",
    origin: webOrigin,
    payload: { characterId, displayName, email, password }
  });
  assert(result.response.status === 201, `Signup failed for ${email}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return { cookie: responseCookie(result.response), userId: result.body.user.id };
}

async function initiate(baseUrl, webOrigin, cookie, fileName, mimeType, content, source = "file_upload", expectedHash = sha256(content)) {
  const result = await jsonRequest(baseUrl, "/media/uploads", {
    cookie,
    method: "POST",
    origin: webOrigin,
    payload: {
      clientUploadId: `media-${randomUUID()}`,
      declaredMimeType: mimeType,
      fileName,
      sha256Hex: expectedHash,
      sizeBytes: content.length,
      source
    }
  });
  assert(result.response.status === 201, `Upload initiation failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function uploadPart(baseUrl, webOrigin, cookie, session, partNumber, content) {
  const response = await rawRequest(baseUrl, `/media/uploads/${session.id}/parts/${partNumber}`, {
    body: content,
    cookie,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-HahaTalk-Part-Sha256": sha256(content)
    },
    method: "PUT",
    origin: webOrigin
  });
  const responseBody = await response.json();
  assert(response.status === 200, `Part ${partNumber} upload failed: ${response.status} ${JSON.stringify(responseBody)}`);
  assert(responseBody.sha256Hex === sha256(content), `Part ${partNumber} hash was not echoed correctly.`);
}

async function complete(baseUrl, webOrigin, cookie, session, hash) {
  const result = await jsonRequest(baseUrl, `/media/uploads/${session.id}/complete`, {
    cookie,
    method: "POST",
    origin: webOrigin,
    payload: { sha256Hex: hash }
  });
  if (result.response.status !== 201) await delay(500);
  assert(result.response.status === 201, `Upload completion failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function uploadBuffer(baseUrl, webOrigin, cookie, fileName, mimeType, content, source = "file_upload") {
  const session = await initiate(baseUrl, webOrigin, cookie, fileName, mimeType, content, source);
  for (let index = 0; index < session.partCount; index += 1) {
    const start = index * session.partSizeBytes;
    const part = content.subarray(start, Math.min(content.length, start + session.partSizeBytes));
    await uploadPart(baseUrl, webOrigin, cookie, session, index + 1, part);
  }
  return complete(baseUrl, webOrigin, cookie, session, sha256(content));
}

async function share(baseUrl, webOrigin, cookie, assetId, targetUserIds, audienceType = "selected") {
  const result = await jsonRequest(baseUrl, `/media/assets/${assetId}/share`, {
    cookie,
    method: "POST",
    origin: webOrigin,
    payload: {
      archiveScope: audienceType === "all" ? "shared" : "selected",
      audienceType,
      caption: "Stage 5 secure media share",
      clientMessageId: `media-share-${randomUUID()}`,
      spaceId: hubId,
      targetUserIds
    }
  });
  assert(result.response.status === 201, `Media share failed: ${result.response.status} ${JSON.stringify(result.body)}`);
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

  const owner = await signup(baseUrl, webOrigin, "you@inviz.co.kr", "Stage5!OwnerPass", "Stage5 Owner", "char-calm-lead");
  const mina = await signup(baseUrl, webOrigin, "mina@inviz.co.kr", "Stage5!MinaPass", "Stage5 Mina", "char-focus-maker");
  const jun = await signup(baseUrl, webOrigin, "jun@inviz.co.kr", "Stage5!JunPass", "Stage5 Jun", "char-calm-lead");
  const hana = await signup(baseUrl, webOrigin, "hana.customer@example.com", "Stage5!HanaPass", "Stage5 Hana", "char-customer-guest");

  const largeText = Buffer.concat([Buffer.alloc(4 * 1024 * 1024, "a"), Buffer.from("restart-safe")]);
  const resumable = await initiate(baseUrl, webOrigin, owner.cookie, "restart.txt", "text/plain", largeText);
  assert(resumable.partCount === 2, "Multipart fixture did not create two parts.");
  await uploadPart(baseUrl, webOrigin, owner.cookie, resumable, 1, largeText.subarray(0, resumable.partSizeBytes));

  const chatWhileUploading = await jsonRequest(baseUrl, "/messages", {
    cookie: owner.cookie,
    method: "POST",
    origin: webOrigin,
    payload: {
      audienceType: "selected",
      body: "Text chat remains independent from an unfinished upload.",
      clientMessageId: `stage5-chat-${randomUUID()}`,
      requiresConfirmation: false,
      spaceId: hubId,
      targetUserIds: [mina.userId]
    }
  });
  assert(chatWhileUploading.response.status === 201, "Text chat waited for or failed with an unfinished upload.");

  await database.query(
    "update schema_migrations set checksum = $2 where version = $1",
    ["004_contacts_family_managed_groups.sql", "363d058bc257074438363ac3cd445371d72a8f791d7da11b64c6773bc320a387"]
  );

  await stopApi(api);
  api = await startApi(port, webOrigin);
  const reconciliation = await database.query(
    `select count(*)::int as count from schema_migration_reconciliations
     where version = '004_contacts_family_managed_groups.sql'
       and reason = 'stage4-pre-release-schema-equivalent'`
  );
  assert(reconciliation.rows[0].count === 1, "Known Stage 4 schema-equivalent checksum was not reconciled with evidence.");
  const resumedView = await jsonRequest(baseUrl, `/media/uploads/${resumable.id}`, { cookie: owner.cookie });
  assert(resumedView.response.status === 200, "Upload session did not survive API restart.");
  assert(JSON.stringify(resumedView.body.uploadedPartNumbers) === "[1]", "Uploaded part checkpoint was not restored.");
  await uploadPart(baseUrl, webOrigin, owner.cookie, resumable, 2, largeText.subarray(resumable.partSizeBytes));
  const resumedAsset = await complete(baseUrl, webOrigin, owner.cookie, resumable, sha256(largeText));
  assert(resumedAsset.processingStatus === "ready" && resumedAsset.sha256Hex === sha256(largeText), "Resumed asset integrity failed.");

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const image = await uploadBuffer(baseUrl, webOrigin, owner.cookie, "stage5.png", "image/png", png, "screen_capture");
  assert(image.archiveScope === "private_archive", "New media was not private by default.");
  assert(image.processingStatus === "ready" && image.virusScanStatus === "clean", "Clean PNG was not accepted.");
  assert(image.previewStatus === "ready" && image.previewUrl, "GPS-safe image preview was not created.");
  assert(!JSON.stringify(image).includes(objectRoot) && !JSON.stringify(image).includes("original_object_key"), "Asset response leaked a storage path.");

  const privateDenied = await jsonRequest(baseUrl, `/media/assets/${image.id}`, { cookie: mina.cookie });
  assert(privateDenied.response.status === 404, "Private archive asset was visible before sharing.");
  const privateByteDenied = await rawRequest(baseUrl, `/media/assets/${image.id}/content?variant=preview`, { cookie: mina.cookie });
  assert(privateByteDenied.status === 404, "Private archive bytes were visible before sharing.");

  const ownerRange = await rawRequest(baseUrl, `/media/assets/${image.id}/content?variant=original`, {
    cookie: owner.cookie,
    headers: { Range: "bytes=0-7" }
  });
  assert(ownerRange.status === 206, "Authenticated byte range did not return 206.");
  assert(ownerRange.headers.get("content-range") === `bytes 0-7/${png.length}`, "Byte range metadata is incorrect.");
  assert(Buffer.from(await ownerRange.arrayBuffer()).equals(png.subarray(0, 8)), "Byte range content is incorrect.");

  const minaShare = await share(baseUrl, webOrigin, owner.cookie, image.id, [mina.userId]);
  assert(minaShare.message.attachments[0]?.assetId === image.id, "Media message did not project its attachment.");
  assert(!("storageKey" in minaShare.message.attachments[0]), "Attachment projection leaked a storage key.");
  const minaAsset = await jsonRequest(baseUrl, `/media/assets/${image.id}`, { cookie: mina.cookie });
  assert(minaAsset.response.status === 200 && minaAsset.body.previewUrl, "Selected recipient did not receive preview access.");
  assert(!minaAsset.body.capturedTimezone && !minaAsset.body.sha256Hex, "Recipient received owner-private media metadata.");
  const junAsset = await jsonRequest(baseUrl, `/media/assets/${image.id}`, { cookie: jun.cookie });
  assert(junAsset.response.status === 404, "Unselected hub participant received media access.");
  const junHub = await jsonRequest(baseUrl, `/spaces/${hubId}/view`, { cookie: jun.cookie });
  assert(!junHub.body.messages.some((message) => message.id === minaShare.message.id), "Hidden hub media message leaked to another spoke.");

  const revoked = await jsonRequest(baseUrl, `/media/assets/${image.id}/shares/${minaShare.message.id}`, {
    cookie: owner.cookie,
    method: "DELETE",
    origin: webOrigin,
    payload: {}
  });
  assert(revoked.response.status === 200, "Media share revocation failed.");
  const minaAfterRevoke = await jsonRequest(baseUrl, `/media/assets/${image.id}`, { cookie: mina.cookie });
  assert(minaAfterRevoke.response.status === 404, "Revoked recipient retained media access.");
  const ownerAfterRevoke = await rawRequest(baseUrl, `/media/assets/${image.id}/content?variant=original`, { cookie: owner.cookie });
  assert(ownerAfterRevoke.status === 200, "Share revocation deleted the owner's private original.");
  await ownerAfterRevoke.arrayBuffer();

  const guestShare = await share(baseUrl, webOrigin, owner.cookie, image.id, [hana.userId]);
  const guestAsset = await jsonRequest(baseUrl, `/media/assets/${image.id}`, { cookie: hana.cookie });
  assert(guestAsset.response.status === 200 && guestAsset.body.previewUrl, "Guest did not receive allowed preview access.");
  assert(!guestAsset.body.downloadUrl && guestAsset.body.canDownload === false, "Guest received a forbidden download URL.");
  const guestPreview = await rawRequest(baseUrl, guestAsset.body.previewUrl, { cookie: hana.cookie });
  assert(guestPreview.status === 200, "Guest safe image preview failed.");
  await guestPreview.arrayBuffer();
  const guestDownload = await rawRequest(baseUrl, `/media/assets/${image.id}/content?variant=original&download=1`, { cookie: hana.cookie });
  assert(guestDownload.status === 403, "Guest downloaded an original against room policy.");
  await jsonRequest(baseUrl, `/media/assets/${image.id}/shares/${guestShare.message.id}`, {
    cookie: owner.cookie,
    method: "DELETE",
    origin: webOrigin,
    payload: {}
  });

  const guestPdfBytes = Buffer.from("%PDF-1.4\nHahaTalk guest preview\n%%EOF\n", "ascii");
  const guestPdf = await uploadBuffer(baseUrl, webOrigin, owner.cookie, "guest-preview.pdf", "application/pdf", guestPdfBytes);
  const guestPdfShare = await share(baseUrl, webOrigin, owner.cookie, guestPdf.id, [hana.userId]);
  const guestPdfAsset = await jsonRequest(baseUrl, `/media/assets/${guestPdf.id}`, { cookie: hana.cookie });
  assert(guestPdfAsset.response.status === 200 && guestPdfAsset.body.previewUrl, "Guest PDF preview URL was not projected.");
  assert(!guestPdfAsset.body.downloadUrl && guestPdfAsset.body.canDownload === false, "Guest PDF exposed a download capability.");
  const guestPdfPreview = await rawRequest(baseUrl, guestPdfAsset.body.previewUrl, { cookie: hana.cookie });
  assert(guestPdfPreview.status === 200, "Guest could not use an allowed inline PDF preview.");
  assert(Buffer.from(await guestPdfPreview.arrayBuffer()).equals(guestPdfBytes), "Guest PDF preview bytes changed.");
  const guestPdfDownload = await rawRequest(baseUrl, `/media/assets/${guestPdf.id}/content?variant=original&download=1`, { cookie: hana.cookie });
  assert(guestPdfDownload.status === 403, "Guest downloaded a PDF against room policy.");
  await jsonRequest(baseUrl, `/media/assets/${guestPdf.id}/shares/${guestPdfShare.message.id}`, {
    cookie: owner.cookie,
    method: "DELETE",
    origin: webOrigin,
    payload: {}
  });

  const malwareTest = Buffer.from("HAHATALK-BLOCKED-MALWARE-TEST-FILE", "ascii");
  const blocked = await uploadBuffer(baseUrl, webOrigin, owner.cookie, "malware-test.txt", "text/plain", malwareTest);
  assert(blocked.processingStatus === "blocked" && blocked.virusScanStatus === "blocked", "Malware fixture was not quarantined.");
  assert(!blocked.previewUrl && !blocked.downloadUrl, "Quarantined asset exposed content URLs.");
  const blockedContent = await rawRequest(baseUrl, `/media/assets/${blocked.id}/content?variant=original`, { cookie: owner.cookie });
  assert(blockedContent.status === 403, "Quarantined bytes were served to the owner.");
  const blockedShare = await jsonRequest(baseUrl, `/media/assets/${blocked.id}/share`, {
    cookie: owner.cookie,
    method: "POST",
    origin: webOrigin,
    payload: {
      archiveScope: "selected",
      audienceType: "selected",
      clientMessageId: `blocked-${randomUUID()}`,
      spaceId: hubId,
      targetUserIds: [mina.userId]
    }
  });
  assert(blockedShare.response.status === 409, "Quarantined asset was shared.");

  const wrongHashSession = await initiate(
    baseUrl,
    webOrigin,
    owner.cookie,
    "wrong-hash.txt",
    "text/plain",
    Buffer.from("actual"),
    "file_upload",
    "0".repeat(64)
  );
  await uploadPart(baseUrl, webOrigin, owner.cookie, wrongHashSession, 1, Buffer.from("actual"));
  const wrongHash = await complete(baseUrl, webOrigin, owner.cookie, wrongHashSession, "0".repeat(64));
  assert(wrongHash.processingStatus === "blocked", "Final SHA-256 mismatch did not fail closed.");

  const metadata = await jsonRequest(baseUrl, `/media/assets/${image.id}`, {
    cookie: owner.cookie,
    method: "PATCH",
    origin: webOrigin,
    payload: { capturedLocalAt: "2026-07-12T15:30:00", placeName: "서울 본사" }
  });
  assert(
    metadata.response.status === 200
      && metadata.body.placeName === "서울 본사"
      && metadata.body.capturedAt === "2026-07-12T15:30:00",
    "Owner media metadata did not preserve its timezone-free local wall-clock."
  );
  const filtered = await jsonRequest(
    baseUrl,
    `/media/library?date=2026-07-12&place=${encodeURIComponent("서울")}&scope=private_archive`,
    { cookie: owner.cookie }
  );
  assert(filtered.response.status === 200 && filtered.body.assets.some((asset) => asset.id === image.id), "Indexed date/place library filter missed the asset.");

  const album = await jsonRequest(baseUrl, "/media/albums", {
    cookie: owner.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { description: "Stage 5 album", name: "현장 사진" }
  });
  assert(album.response.status === 201, "Album creation failed.");
  const albumItem = await jsonRequest(baseUrl, `/media/albums/${album.body.id}/items`, {
    cookie: owner.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { assetId: image.id }
  });
  assert(albumItem.response.status === 201 && albumItem.body.assetIds.includes(image.id), "Album item was not persisted.");

  const grants = await database.query(
    `select count(*)::int as active_count from media_grants
     where asset_id = $1 and revoked_at is null`,
    [image.id]
  );
  assert(grants.rows[0].active_count === 0, "Revoked media grants remained active.");
  const audit = await database.query(
    `select count(*)::int as count from audit_logs
     where target_id = $1 and action in ('media.upload.completed', 'media.share.created', 'media.share.revoked', 'media.metadata.updated')`,
    [image.id]
  );
  assert(audit.rows[0].count >= 4, "Media audit trail is incomplete.");

  await stopApi(api);
  api = await startApi(port, webOrigin);
  const afterRestart = await rawRequest(baseUrl, `/media/assets/${image.id}/content?variant=original`, { cookie: owner.cookie });
  assert(afterRestart.status === 200 && Buffer.from(await afterRestart.arrayBuffer()).equals(png), "Media original did not survive API restart.");

  console.log("Media document desk check passed: resumable integrity, chat independence, quarantine, private archive, hub-safe grants, guest policy, revoke, range, metadata filters, albums, audit, and restart restore.");
} catch (error) {
  console.error(api?.logs.join("") ?? "Media API logs unavailable.");
  throw error;
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
  await rm(objectRoot, { force: true, recursive: true }).catch(() => undefined);
}
