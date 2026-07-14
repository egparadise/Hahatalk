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
const databaseName = `hahatalk_ai_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const objectRoot = await mkdtemp(path.join(os.tmpdir(), "hahatalk-ai-"));
const cookieName = "hahatalk_ai_session";
const workerToken = "stage8-worker-token-at-least-24-characters";
const hubId = "00000000-0000-4000-8000-000000000201";
const groupId = "00000000-0000-4000-8000-000000000202";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function pcmWav() {
  const samples = Buffer.alloc(16_000 * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
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
      AI_WORKER_TOKEN: workerToken,
      DATABASE_URL: databaseUrl,
      HAHATALK_ALLOW_OPEN_SIGNUP: "true",
      HAHATALK_MIGRATIONS_DIR: migrationsDirectory,
      HAHATALK_OBJECT_ROOT: objectRoot,
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
    if (child.exitCode !== null) throw new Error(`AI API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // Fresh migrations may take several seconds on Windows.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`AI API did not become healthy.\n${logs.join("")}`);
}

async function stopApi(api) {
  if (!api?.child || api.child.exitCode !== null) return;
  api.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => api.child.once("exit", resolve)),
    delay(5_000).then(() => api.child.exitCode === null && api.child.kill())
  ]);
}

async function request(baseUrl, pathName, { cookie, headers = {}, method = "GET", origin, payload, rawBody } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.Cookie = cookie;
  if (origin) requestHeaders.Origin = origin;
  let body = rawBody;
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
  const responseBody = contentType.includes("application/json") ? await response.json() : await response.arrayBuffer();
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
  return { cookie: responseCookie(result.response), userId: result.body.user.id };
}

async function mutate(baseUrl, origin, cookie, pathName, payload, expected = 201, method = "POST") {
  const result = await request(baseUrl, pathName, { cookie, method, origin, payload });
  assert(result.response.status === expected, `${method} ${pathName} expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function uploadBuffer(baseUrl, origin, cookie, fileName, mimeType, content) {
  const initiated = await mutate(baseUrl, origin, cookie, "/media/uploads", {
    clientUploadId: `stage8-upload-${randomUUID()}`,
    declaredMimeType: mimeType,
    fileName,
    sha256Hex: sha256(content),
    sizeBytes: content.length,
    source: "file_upload"
  });
  for (let index = 0; index < initiated.partCount; index += 1) {
    const start = index * initiated.partSizeBytes;
    const part = content.subarray(start, Math.min(content.length, start + initiated.partSizeBytes));
    const uploaded = await request(baseUrl, `/media/uploads/${initiated.id}/parts/${index + 1}`, {
      cookie,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-HahaTalk-Client": "web-v1",
        "X-HahaTalk-Part-Sha256": sha256(part)
      },
      method: "PUT",
      origin,
      rawBody: part
    });
    assert(uploaded.response.status === 200, `Media part upload failed: ${uploaded.response.status} ${JSON.stringify(uploaded.body)}`);
  }
  return mutate(baseUrl, origin, cookie, `/media/uploads/${initiated.id}/complete`, { sha256Hex: sha256(content) });
}

async function workerRequest(baseUrl, pathName, payload, expected = 201, token = workerToken) {
  const result = await request(baseUrl, pathName, {
    headers: { "X-HahaTalk-AI-Worker-Token": token },
    method: "POST",
    payload
  });
  assert(result.response.status === expected, `Worker POST ${pathName} expected ${expected}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function claim(baseUrl, workerId, capabilities) {
  const result = await workerRequest(baseUrl, "/internal/ai/jobs/claim", { capabilities, leaseSeconds: 60, workerId });
  assert(result.job, `Worker ${workerId} did not receive a queued ${capabilities.join(",")} job.`);
  return result.job;
}

async function uploadWorkerOutput(baseUrl, claimRow, fileName, mimeType, content) {
  const result = await request(baseUrl, `/internal/ai/jobs/${claimRow.id}/output`, {
    headers: {
      "Content-Type": mimeType,
      "X-HahaTalk-AI-Fencing-Token": String(claimRow.fencingToken),
      "X-HahaTalk-AI-Worker-Id": "stage8-worker-b",
      "X-HahaTalk-AI-Worker-Token": workerToken,
      "X-HahaTalk-File-Name": encodeURIComponent(fileName)
    },
    method: "PUT",
    rawBody: content
  });
  assert(result.response.status === 200, `Worker output upload failed: ${result.response.status} ${JSON.stringify(result.body)}`);
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

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const origin = `http://127.0.0.1:${await availablePort()}`;
  api = await startApi(port, origin);

  const owner = await signup(baseUrl, origin, "you@inviz.co.kr", "Stage8!OwnerPass", "Stage8 Owner", "char-calm-lead");
  const mina = await signup(baseUrl, origin, "mina@inviz.co.kr", "Stage8!MinaPass", "Stage8 Mina", "char-focus-maker");
  const jun = await signup(baseUrl, origin, "jun@inviz.co.kr", "Stage8!JunPass", "Stage8 Jun", "char-calm-lead");

  const chatWithoutWorker = await mutate(baseUrl, origin, owner.cookie, "/messages", {
    audienceType: "selected",
    body: "AI worker가 없어도 일반 채팅은 계속됩니다.",
    clientMessageId: `stage8-chat-${randomUUID()}`,
    requiresConfirmation: false,
    spaceId: hubId,
    targetUserIds: [mina.userId]
  });
  assert(chatWithoutWorker.message.body.includes("일반 채팅"), "Chat was coupled to AI worker availability.");

  const audio = await uploadBuffer(baseUrl, origin, owner.cookie, "stage8-voice.wav", "audio/wav", pcmWav());
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const image = await uploadBuffer(baseUrl, origin, owner.cookie, "stage8-photo.png", "image/png", png);
  assert(audio.mediaKind === "audio" && image.mediaKind === "image", "AI media fixtures were not inspected correctly.");

  const unauthorizedStt = await request(baseUrl, "/ai/jobs/stt", {
    cookie: mina.cookie,
    method: "POST",
    origin,
    payload: { assetId: audio.id, idempotencyKey: `stt-denied-${randomUUID()}`, language: "ko" }
  });
  assert(
    unauthorizedStt.response.status === 404,
    `Private audio authorization returned ${unauthorizedStt.response.status}: ${JSON.stringify(unauthorizedStt.body)}`
  );

  const sttKey = `stage8-stt-${randomUUID()}`;
  const stt = await mutate(baseUrl, origin, owner.cookie, "/ai/jobs/stt", { assetId: audio.id, idempotencyKey: sttKey, language: "ko" });
  const sttReplay = await mutate(baseUrl, origin, owner.cookie, "/ai/jobs/stt", { assetId: audio.id, idempotencyKey: sttKey, language: "ko" });
  assert(sttReplay.id === stt.id, "AI job idempotency created a duplicate STT job.");
  const sttConflict = await request(baseUrl, "/ai/jobs/stt", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { assetId: audio.id, idempotencyKey: sttKey, language: "en" }
  });
  assert(sttConflict.response.status === 409, "AI idempotency key accepted different input.");

  const badWorker = await request(baseUrl, "/internal/ai/jobs/claim", {
    headers: { "X-HahaTalk-AI-Worker-Token": "wrong-worker-token-value-000" },
    method: "POST",
    payload: { capabilities: ["stt"], workerId: "stage8-bad-worker" }
  });
  assert(badWorker.response.status === 403, "Internal AI endpoint accepted an invalid worker token.");

  const firstClaim = await claim(baseUrl, "stage8-worker-a", ["stt"]);
  assert(firstClaim.id === stt.id && !JSON.stringify(firstClaim).includes("검토"), "STT claim leaked unexpected content or selected the wrong job.");
  const inputBytes = await request(baseUrl, `/internal/ai/jobs/${stt.id}/input`, {
    headers: {
      "X-HahaTalk-AI-Fencing-Token": String(firstClaim.fencingToken),
      "X-HahaTalk-AI-Worker-Id": "stage8-worker-a",
      "X-HahaTalk-AI-Worker-Token": workerToken
    }
  });
  assert(inputBytes.response.status === 200 && Buffer.from(inputBytes.body).equals(pcmWav()), "Worker could not read leased STT input.");
  await workerRequest(baseUrl, `/internal/ai/jobs/${stt.id}/heartbeat`, {
    fencingToken: firstClaim.fencingToken,
    progress: 35,
    workerId: "stage8-worker-a"
  });

  await database.query("update ai_jobs set lease_expires_at = now() - interval '1 second' where id = $1", [stt.id]);
  const recoveredClaim = await claim(baseUrl, "stage8-worker-b", ["stt"]);
  assert(recoveredClaim.fencingToken > firstClaim.fencingToken, "Expired AI lease did not advance the fencing token.");
  const staleCompletion = await request(baseUrl, `/internal/ai/jobs/${stt.id}/complete`, {
    headers: { "X-HahaTalk-AI-Worker-Token": workerToken },
    method: "POST",
    payload: {
      fencingToken: firstClaim.fencingToken,
      result: { language: "ko", text: "stale" },
      workerId: "stage8-worker-a"
    }
  });
  assert(staleCompletion.response.status === 409, "A stale worker overwrote a recovered AI lease.");
  await workerRequest(baseUrl, `/internal/ai/jobs/${stt.id}/complete`, {
    fencingToken: recoveredClaim.fencingToken,
    result: {
      language: "ko",
      segments: [{ end: 2.4, start: 0, text: "초안" }],
      text: "AI가 만든 최초 음성 초안입니다."
    },
    workerId: "stage8-worker-b"
  });
  const completedStt = await request(baseUrl, `/ai/jobs/${stt.id}`, { cookie: owner.cookie });
  assert(completedStt.body.status === "succeeded" && completedStt.body.transcript?.reviewStatus === "ai_draft", "STT result was not stored as an AI draft.");
  const transcriptId = completedStt.body.transcript.id;
  const edited = await mutate(baseUrl, origin, owner.cookie, `/ai/transcripts/${transcriptId}`, {
    text: "사용자가 검토하고 고친 음성 메시지입니다."
  }, 200, "PATCH");
  assert(edited.editedText.includes("사용자가"), "Transcript edit was not persisted.");
  const sent = await mutate(baseUrl, origin, owner.cookie, `/ai/transcripts/${transcriptId}/send`, {
    audienceType: "selected",
    clientMessageId: `stage8-transcript-${randomUUID()}`,
    requiresConfirmation: false,
    spaceId: hubId,
    targetUserIds: [mina.userId]
  });
  assert(sent.message.body === edited.editedText && sent.message.metadata.aiDraftReviewed === true, "Reviewed transcript did not use normal message delivery with AI labels.");
  assert(sent.transcript.reviewStatus === "reviewed" && sent.transcript.approvedMessageId === sent.message.id, "Transcript approval did not bind one message.");
  const editAfterSend = await request(baseUrl, `/ai/transcripts/${transcriptId}`, {
    cookie: owner.cookie,
    method: "PATCH",
    origin,
    payload: { text: "should fail" }
  });
  assert(editAfterSend.response.status === 409, "Reviewed transcript remained editable.");

  const hidden = await mutate(baseUrl, origin, owner.cookie, "/messages", {
    audienceType: "private",
    body: "MINA_MUST_NOT_SEE_THIS_PRIVATE_SUMMARY_INPUT",
    clientMessageId: `stage8-hidden-${randomUUID()}`,
    requiresConfirmation: false,
    spaceId: groupId,
    targetUserIds: [jun.userId]
  });
  assert(hidden.message.body.includes("MINA_MUST_NOT"), "Private summary fixture was not created.");
  const summary = await mutate(baseUrl, origin, mina.cookie, "/ai/jobs/summary", {
    idempotencyKey: `stage8-summary-${randomUUID()}`,
    spaceId: groupId
  });
  const summaryClaim = await claim(baseUrl, "stage8-worker-b", ["summary"]);
  assert(summaryClaim.id === summary.id, "Summary worker claimed the wrong job.");
  assert(!JSON.stringify(summaryClaim.input).includes("MINA_MUST_NOT_SEE"), "Summary snapshot included a message invisible to its requester.");
  await workerRequest(baseUrl, `/internal/ai/jobs/${summary.id}/complete`, {
    fencingToken: summaryClaim.fencingToken,
    result: {
      decisions: ["AI 초안은 검토한다."],
      summary: "권한이 있는 대화만 사용한 AI 요약 초안입니다.",
      tasks: [{ assignee: mina.userId, title: "요약 검토" }]
    },
    workerId: "stage8-worker-b"
  });

  let oldQwenRejected = false;
  try {
    await database.query(
      `insert into ai_model_configs (capability, provider, model_family, model_name, minimum_version, deployment_mode)
       values ('summary', 'qwen', 'qwen', 'Qwen3.4-test', '3.4', 'local')`
    );
  } catch (error) {
    oldQwenRejected = error?.code === "23514";
  }
  assert(oldQwenRejected, "Schema accepted a summary model older than Qwen 3.5.");

  const tts = await mutate(baseUrl, origin, owner.cookie, "/ai/jobs/tts", {
    idempotencyKey: `stage8-tts-${randomUUID()}`,
    speed: 1,
    text: "안녕하세요. 인비즈 업무 음성입니다.",
    voiceId: "Sohee"
  });
  const ttsClaim = await claim(baseUrl, "stage8-worker-b", ["tts"]);
  assert(ttsClaim.id === tts.id && ttsClaim.model.name.includes("Qwen3-TTS"), "Standard Korean TTS selected the wrong model.");
  const ttsOutput = await uploadWorkerOutput(baseUrl, ttsClaim, "stage8-sohee.wav", "audio/wav", pcmWav());
  await workerRequest(baseUrl, `/internal/ai/jobs/${tts.id}/complete`, {
    fencingToken: ttsClaim.fencingToken,
    result: { durationMs: 1000, outputAssetId: ttsOutput.assetId },
    workerId: "stage8-worker-b"
  });
  const cachedTts = await mutate(baseUrl, origin, owner.cookie, "/ai/jobs/tts", {
    idempotencyKey: `stage8-tts-cache-${randomUUID()}`,
    speed: 1,
    text: "안녕하세요. 인비즈 업무 음성입니다.",
    voiceId: "Sohee"
  });
  assert(cachedTts.status === "succeeded" && cachedTts.resultJson.cacheHit === true, "Standard TTS cache did not reuse the private generated asset.");

  const refusedConsent = await request(baseUrl, "/ai/voice-consents", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { acknowledged: false, referenceAssetId: audio.id }
  });
  assert(refusedConsent.response.status === 400, "Voice profile consent was created without disclosure acknowledgement.");
  const consent = await mutate(baseUrl, origin, owner.cookie, "/ai/voice-consents", {
    acknowledged: true,
    expiresInDays: 30,
    referenceAssetId: audio.id
  });
  const profileBundle = await mutate(baseUrl, origin, owner.cookie, "/ai/voice-profiles", {
    consentId: consent.id,
    idempotencyKey: `stage8-voice-profile-${randomUUID()}`
  });
  const enrollmentClaim = await claim(baseUrl, "stage8-worker-b", ["voice_profile_enrollment"]);
  const unsafeEnrollment = await request(baseUrl, `/internal/ai/jobs/${enrollmentClaim.id}/complete`, {
    headers: { "X-HahaTalk-AI-Worker-Token": workerToken },
    method: "POST",
    payload: {
      fencingToken: enrollmentClaim.fencingToken,
      result: { encryptedEmbeddingKey: "plain-file.bin", watermarked: false },
      workerId: "stage8-worker-b"
    }
  });
  assert(unsafeEnrollment.response.status === 400, "Unencrypted or non-watermarked voice enrollment was accepted.");
  await workerRequest(baseUrl, `/internal/ai/jobs/${enrollmentClaim.id}/complete`, {
    fencingToken: enrollmentClaim.fencingToken,
    result: { encryptedEmbeddingKey: `vault://stage8/${profileBundle.profile.id}`, watermarked: true },
    workerId: "stage8-worker-b"
  });
  const profileTts = await mutate(baseUrl, origin, owner.cookie, "/ai/jobs/tts", {
    idempotencyKey: `stage8-profile-tts-${randomUUID()}`,
    speed: 1,
    text: "동의된 개인 음성 테스트",
    voiceProfileId: profileBundle.profile.id
  });
  const profileTtsClaim = await claim(baseUrl, "stage8-worker-b", ["tts"]);
  assert(profileTtsClaim.id === profileTts.id, "Consented profile TTS was not queued.");
  const revoked = await request(baseUrl, `/ai/voice-profiles/${profileBundle.profile.id}`, {
    cookie: owner.cookie,
    method: "DELETE",
    origin,
    payload: {}
  });
  assert(revoked.response.status === 200 && revoked.body.status === "deleting", "Voice profile revocation did not queue deletion.");
  const revokedCompletion = await request(baseUrl, `/internal/ai/jobs/${profileTts.id}/complete`, {
    headers: { "X-HahaTalk-AI-Worker-Token": workerToken },
    method: "POST",
    payload: {
      fencingToken: profileTtsClaim.fencingToken,
      result: { outputAssetId: ttsOutput.assetId },
      workerId: "stage8-worker-b"
    }
  });
  assert(revokedCompletion.response.status === 409, "Revoked voice profile accepted an in-flight synthesis result.");
  const ttsAfterRevoke = await request(baseUrl, "/ai/jobs/tts", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: {
      idempotencyKey: `stage8-revoked-tts-${randomUUID()}`,
      text: "철회 뒤에는 합성 금지",
      voiceProfileId: profileBundle.profile.id
    }
  });
  assert(ttsAfterRevoke.response.status === 403, "Revoked voice profile created a new synthesis job.");
  const deletionClaim = await claim(baseUrl, "stage8-worker-b", ["voice_profile_delete"]);
  await workerRequest(baseUrl, `/internal/ai/jobs/${deletionClaim.id}/complete`, {
    fencingToken: deletionClaim.fencingToken,
    result: { deleted: true },
    workerId: "stage8-worker-b"
  });
  const profiles = await request(baseUrl, "/ai/voice-profiles", { cookie: owner.cookie });
  assert(profiles.body.some((profile) => profile.id === profileBundle.profile.id && profile.status === "deleted"), "Revoked voice embedding was not marked deleted.");

  const noAvatarConsent = await request(baseUrl, "/ai/jobs/avatar", {
    cookie: owner.cookie,
    method: "POST",
    origin,
    payload: { assetId: image.id, consentToStoreSource: false, idempotencyKey: `avatar-no-${randomUUID()}` }
  });
  assert(noAvatarConsent.response.status === 400, "Avatar job accepted a source without storage consent.");
  const avatar = await mutate(baseUrl, origin, owner.cookie, "/ai/jobs/avatar", {
    assetId: image.id,
    consentToStoreSource: true,
    idempotencyKey: `stage8-avatar-${randomUUID()}`,
    style: "work-friendly"
  });
  const avatarClaim = await claim(baseUrl, "stage8-worker-b", ["avatar_generation"]);
  assert(avatarClaim.id === avatar.id, "Avatar worker claimed the wrong job.");
  const avatarOutput = await uploadWorkerOutput(baseUrl, avatarClaim, "stage8-caricature.png", "image/png", png);
  await workerRequest(baseUrl, `/internal/ai/jobs/${avatar.id}/complete`, {
    fencingToken: avatarClaim.fencingToken,
    result: { outputAssetId: avatarOutput.assetId },
    workerId: "stage8-worker-b"
  });
  const avatars = await request(baseUrl, "/ai/avatars", { cookie: owner.cookie });
  assert(avatars.body.some((row) => row.status === "active" && row.displayAssetId === avatarOutput.assetId), "Avatar output was not activated.");

  const failingSummary = await mutate(baseUrl, origin, owner.cookie, "/ai/jobs/summary", {
    idempotencyKey: `stage8-fail-${randomUUID()}`,
    spaceId: hubId
  });
  const failingClaim = await claim(baseUrl, "stage8-worker-b", ["summary"]);
  await workerRequest(baseUrl, `/internal/ai/jobs/${failingSummary.id}/fail`, {
    errorCode: "model_unavailable",
    errorMessage: "bounded",
    fencingToken: failingClaim.fencingToken,
    retryable: false,
    workerId: "stage8-worker-b"
  });
  const retried = await mutate(baseUrl, origin, owner.cookie, `/ai/jobs/${failingSummary.id}/retry`, {}, 201);
  assert(retried.status === "queued", "Manual AI retry did not restore a failed job.");
  const cancelled = await mutate(baseUrl, origin, owner.cookie, `/ai/jobs/${failingSummary.id}/cancel`, {}, 201);
  assert(cancelled.status === "cancelled", "Queued AI job cancellation failed.");

  const dispatchColumns = await database.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_job_dispatches'`
  );
  assert(!dispatchColumns.rows.some((row) => row.column_name.includes("payload")), "AI dispatch table can retain sensitive payload content.");
  const dispatches = await database.query("select distinct transport, status from ai_job_dispatches");
  assert(dispatches.rows.every((row) => row.transport === "database_poll" && row.status === "published"), "Database polling fallback did not acknowledge durable dispatches.");

  const beforeRestart = await request(baseUrl, "/ai/jobs", { cookie: owner.cookie });
  await stopApi(api);
  api = await startApi(port, origin);
  const afterRestart = await request(baseUrl, "/ai/jobs", { cookie: owner.cookie });
  assert(afterRestart.body.length === beforeRestart.body.length, "AI job ledger did not survive API restart.");
  const chatAfterRestart = await mutate(baseUrl, origin, owner.cookie, "/messages", {
    audienceType: "selected",
    body: "AI 재시작 뒤에도 채팅은 독립적으로 동작합니다.",
    clientMessageId: `stage8-chat-restart-${randomUUID()}`,
    requiresConfirmation: false,
    spaceId: hubId,
    targetUserIds: [mina.userId]
  });
  assert(chatAfterRestart.message.body.includes("독립적"), "Chat failed after AI ledger restart.");

  const capabilities = await request(baseUrl, "/ai/capabilities", { cookie: owner.cookie });
  assert(capabilities.response.status === 200 && capabilities.body.chatIndependent && capabilities.body.durableQueue, "AI capability projection is incomplete.");
  assert(!JSON.stringify(capabilities.body).includes(workerToken), "AI capability response leaked worker credentials.");

  const audit = await database.query(
    `select count(*)::int as count from audit_logs
     where action in ('ai.job.created', 'ai.voice_consent.granted', 'ai.voice_profile.revoked')`
  );
  assert(audit.rows[0].count >= 3, "Sensitive AI operations were not audited.");
  const schema = await database.query(
    `select count(*)::int as count from information_schema.tables
     where table_schema = 'public' and table_name in (
       'ai_model_configs', 'ai_workers', 'ai_jobs', 'ai_job_attempts', 'ai_job_dispatches',
       'ai_summary_inputs', 'voice_transcripts', 'voice_profile_consents', 'voice_profiles',
       'tts_assets', 'avatar_profiles'
     )`
  );
  assert(schema.rows[0].count === 11, "Stage 8 migration is incomplete.");

  console.log("AI voice workbench integration passed.");
} catch (error) {
  if (api?.logs?.length) console.error(api.logs.join(""));
  throw error;
} finally {
  await stopApi(api).catch(() => undefined);
  if (databaseConnected) await database.end().catch(() => undefined);
  if (adminConnected) {
    await adminDatabase.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
      [databaseName]
    ).catch(() => undefined);
    await adminDatabase.query(`drop database if exists "${databaseName}"`).catch(() => undefined);
    await adminDatabase.end().catch(() => undefined);
  }
  await rm(objectRoot, { force: true, recursive: true }).catch(() => undefined);
}
