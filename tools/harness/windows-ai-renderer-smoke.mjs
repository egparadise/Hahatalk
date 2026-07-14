import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function isPortOpen(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(700, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
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

async function pathExists(candidatePath) {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForRuntime(statusPath, expectedPid) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const status = JSON.parse(await readFile(statusPath, "utf8"));
      if (status.pid === expectedPid && status.rendererReady && status.rendererApiHealthy) return status;
    } catch {
      // Runtime status is created and enriched during startup.
    }
    await delay(250);
  }
  throw new Error("Installed AI renderer did not become ready.");
}

async function waitForDebugTarget(port) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
        if (target) return target;
      }
    } catch {
      // Chromium debugging endpoint is still opening.
    }
    await delay(125);
  }
  throw new Error("Installed AI renderer CDP target did not become ready.");
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let requestId = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { reject, resolve });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Renderer evaluation failed.");
  }
  return result.result?.value;
}

async function waitForExpression(cdp, expression, message, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await delay(125);
  }
  const body = await evaluate(cdp, "document.body.innerText").catch(() => "renderer text unavailable");
  throw new Error(`${message}\nRenderer text: ${String(body).slice(-2400)}`);
}

async function captureScreenshot(cdp, outputPath) {
  await cdp.send("Page.bringToFront");
  await evaluate(cdp, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await delay(500);
  const result = await cdp.send("Page.captureScreenshot", { captureBeyondViewport: false, format: "png", fromSurface: true });
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  assert((await readFile(outputPath)).length > 25_000, "Installed AI workbench screenshot is unexpectedly small.");
}

async function signup(runtime, email, password, displayName, characterId) {
  const response = await fetch(`${runtime.apiUrl}/auth/signup`, {
    body: JSON.stringify({ characterId, displayName, email, password }),
    headers: { "Content-Type": "application/json", "Origin": runtime.webUrl, "X-HahaTalk-Client": "web-v1" },
    method: "POST",
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  assert(response.status === 201, `Installed AI user claim failed: ${response.status} ${text}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "Installed AI user claim did not return a cookie.");
  return { body: JSON.parse(text), cookie };
}

async function apiRequest(runtime, cookie, pathName, { method = "GET", payload } = {}) {
  const response = await fetch(`${runtime.apiUrl}${pathName}`, {
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    headers: {
      Cookie: cookie,
      ...(payload !== undefined ? { "Content-Type": "application/json", Origin: runtime.webUrl, "X-HahaTalk-Client": "web-v1" } : {})
    },
    method,
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  assert(response.ok, `${method} ${pathName} failed: ${response.status} ${text}`);
  return body;
}

async function workerRequest(runtime, pathName, payload) {
  const response = await fetch(`${runtime.apiUrl}${pathName}`, {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json", "X-HahaTalk-AI-Worker-Token": workerToken },
    method: "POST",
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  assert(response.ok, `Worker ${pathName} failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function claim(runtime, capability, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await workerRequest(runtime, "/internal/ai/jobs/claim", {
      capabilities: [capability],
      leaseSeconds: 90,
      workerId
    });
    if (result.job) return result.job;
    await delay(125);
  }
  throw new Error(`Installed worker did not claim ${capability}.`);
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

async function uploadAudio(runtime, cookie, content) {
  const upload = await apiRequest(runtime, cookie, "/media/uploads", {
    method: "POST",
    payload: {
      clientUploadId: `renderer-ai-${randomUUID()}`,
      declaredMimeType: "audio/wav",
      fileName: "renderer-voice.wav",
      sha256Hex: sha256(content),
      sizeBytes: content.length,
      source: "file_upload"
    }
  });
  const partResponse = await fetch(`${runtime.apiUrl}/media/uploads/${upload.id}/parts/1`, {
    body: content,
    headers: {
      "Content-Type": "application/octet-stream",
      Cookie: cookie,
      Origin: runtime.webUrl,
      "X-HahaTalk-Client": "web-v1",
      "X-HahaTalk-Part-Sha256": sha256(content)
    },
    method: "PUT",
    signal: AbortSignal.timeout(20_000)
  });
  assert(partResponse.ok, `Installed audio upload failed: ${partResponse.status} ${await partResponse.text()}`);
  return apiRequest(runtime, cookie, `/media/uploads/${upload.id}/complete`, {
    method: "POST",
    payload: { sha256Hex: sha256(content) }
  });
}

async function uploadWorkerOutput(runtime, claimRow, content) {
  const response = await fetch(`${runtime.apiUrl}/internal/ai/jobs/${claimRow.id}/output`, {
    body: content,
    headers: {
      "Content-Type": "audio/wav",
      "X-HahaTalk-AI-Fencing-Token": String(claimRow.fencingToken),
      "X-HahaTalk-AI-Worker-Id": workerId,
      "X-HahaTalk-AI-Worker-Token": workerToken,
      "X-HahaTalk-File-Name": "renderer-sohee.wav"
    },
    method: "PUT",
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  assert(response.ok, `Installed TTS output upload failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function loginRenderer(cdp, email, password) {
  await evaluate(cdp, `
    (() => {
      const loginButton = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '로그인');
      loginButton?.click();
    })()
  `);
  await waitForExpression(cdp, "document.body.innerText.includes('HahaTalk 로그인')", "Installed AI login form did not open.");
  await evaluate(cdp, `
    (() => {
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const setValue = (input, value) => {
        inputSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(document.querySelector('input[type="email"]'), ${JSON.stringify(email)});
      setValue(document.querySelector('input[type="password"]'), ${JSON.stringify(password)});
      document.querySelector('form').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, "document.querySelector('.app-shell') !== null", "Installed AI login did not reach the app.");
}

const desktopPackage = JSON.parse(await readFile(path.join(process.cwd(), "apps", "desktop", "package.json"), "utf8"));
const executablePath = path.resolve(argument(
  "executable",
  path.join(process.env.LOCALAPPDATA ?? "", "HahaTalk", `app-${desktopPackage.version}`, "HahaTalk.exe")
));
const screenshotPath = path.resolve(argument(
  "screenshot",
  path.join(process.cwd(), "apps", "desktop", "out", "stage8-ai-workbench.png")
));
const password = "Stage8!RendererOwner";
const workerToken = "stage8-renderer-worker-token-24-characters";
const workerId = "stage8-renderer-worker";
const tempRoot = path.resolve(await mkdtemp(path.join(os.tmpdir(), "hahatalk-ai-renderer-")));
assert(tempRoot.startsWith(path.resolve(os.tmpdir()) + path.sep), "AI renderer directory escaped system temp.");
const userDataRoot = path.join(tempRoot, "HahaTalk");
const statusPath = path.join(userDataRoot, "runtime-status.json");
const debugPort = await availablePort();
await access(executablePath);

const application = spawn(executablePath, [`--remote-debugging-port=${debugPort}`], {
  env: {
    ...process.env,
    AI_WORKER_TOKEN: workerToken,
    HAHATALK_TEST_FAKE_MEDIA: "1",
    HAHATALK_USER_DATA_DIR: userDataRoot
  },
  stdio: "ignore",
  windowsHide: true
});
let cdp;
let runtime;
try {
  runtime = await waitForRuntime(statusPath, application.pid);
  const owner = await signup(runtime, "you@inviz.co.kr", password, "AI Workbench Owner", "char-calm-lead");
  await signup(runtime, "mina@inviz.co.kr", "Stage8!RendererMina", "AI Workbench Mina", "char-focus-maker");
  await apiRequest(runtime, owner.cookie, "/messages", {
    method: "POST",
    payload: {
      audienceType: "all",
      body: "Stage 8 설치본 AI 작업대 검증 대화",
      clientMessageId: `renderer-chat-${randomUUID()}`,
      requiresConfirmation: false,
      spaceId: owner.body.roomId,
      targetUserIds: []
    }
  });
  const audio = await uploadAudio(runtime, owner.cookie, pcmWav());
  const stt = await apiRequest(runtime, owner.cookie, "/ai/jobs/stt", {
    method: "POST",
    payload: { assetId: audio.id, idempotencyKey: `renderer-stt-${randomUUID()}`, language: "ko" }
  });
  const sttClaim = await claim(runtime, "stt");
  assert(sttClaim.id === stt.id, "Installed renderer STT claim selected the wrong job.");
  await workerRequest(runtime, `/internal/ai/jobs/${stt.id}/complete`, {
    fencingToken: sttClaim.fencingToken,
    result: { language: "ko", segments: [], text: "설치본 STT 검토 전 초안입니다." },
    workerId
  });

  const target = await waitForDebugTarget(debugPort);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 900, mobile: false, width: 1440 });
  await loginRenderer(cdp, "you@inviz.co.kr", password);
  await evaluate(cdp, `document.querySelector('button[title="AI"]').click()`);
  await waitForExpression(cdp, "document.querySelector('.ai-workbench') !== null", "Installed AI workbench did not open.");
  await waitForExpression(
    cdp,
    "document.querySelector('.ai-transcript-draft textarea')?.value.includes('설치본 STT 검토 전 초안') === true",
    "Installed STT draft did not render."
  );

  await evaluate(cdp, `
    (() => {
      const textarea = document.querySelector('.ai-transcript-draft textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '사용자가 설치본에서 검토한 STT 메시지입니다.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.ai-transcript-draft button')]
        .find((button) => button.textContent.includes('현재 대상으로 전송')).click();
    })()
  `);
  await waitForExpression(cdp, "document.body.innerText.includes('사용자가 설치본에서 검토한 STT 메시지')", "Reviewed STT message did not enter the installed conversation.");

  await evaluate(cdp, `document.querySelector('button[title="대화 요약 만들기"]').click()`);
  const summaryClaim = await claim(runtime, "summary");
  await workerRequest(runtime, `/internal/ai/jobs/${summaryClaim.id}/complete`, {
    fencingToken: summaryClaim.fencingToken,
    result: {
      decisions: ["승인 전 STT 초안을 공개하지 않는다."],
      summary: "설치본에서 생성한 대화 요약 초안입니다.",
      tasks: [{ title: "요약 결과 검토" }]
    },
    workerId
  });
  await waitForExpression(cdp, "document.body.innerText.includes('설치본에서 생성한 대화 요약 초안')", "Installed summary result did not render.", 240);

  await evaluate(cdp, `
    (() => {
      const textarea = document.querySelector('.ai-tts-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '설치본 한국어 음성 작업입니다.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.ai-command-section button')]
        .find((button) => button.textContent.includes('음성 만들기')).click();
    })()
  `);
  const ttsClaim = await claim(runtime, "tts");
  const ttsOutput = await uploadWorkerOutput(runtime, ttsClaim, pcmWav());
  await workerRequest(runtime, `/internal/ai/jobs/${ttsClaim.id}/complete`, {
    fencingToken: ttsClaim.fencingToken,
    result: { durationMs: 1000, outputAssetId: ttsOutput.assetId },
    workerId
  });
  await waitForExpression(cdp, "document.querySelector('.ai-job-row audio') !== null", "Installed TTS audio result did not render.", 240);

  const geometry = await evaluate(cdp, `
    (() => {
      const panel = document.querySelector('.right-panel').getBoundingClientRect();
      const workbench = document.querySelector('.ai-workbench').getBoundingClientRect();
      const jobs = [...document.querySelectorAll('.ai-job-row')].map((node) => node.getBoundingClientRect());
      return {
        panel: { bottom: panel.bottom, left: panel.left, right: panel.right, top: panel.top, width: panel.width },
        workbench: { left: workbench.left, right: workbench.right, width: workbench.width },
        jobsFit: jobs.every((rect) => rect.left >= panel.left && rect.right <= panel.right && rect.width > 100),
        viewport: { height: innerHeight, width: innerWidth }
      };
    })()
  `);
  assert(geometry.panel.width >= 300 && geometry.panel.right <= geometry.viewport.width, `AI panel escaped viewport: ${JSON.stringify(geometry)}`);
  assert(geometry.jobsFit && geometry.workbench.width <= geometry.panel.width, `AI job content overlaps its panel: ${JSON.stringify(geometry)}`);
  await captureScreenshot(cdp, screenshotPath);

  await Promise.race([cdp.send("Browser.close").catch(() => undefined), delay(1_000)]);
  for (let attempt = 0; attempt < 120 && (
    isProcessRunning(application.pid)
    || await isPortOpen(runtime.apiPort)
    || await isPortOpen(runtime.webPort)
    || await isPortOpen(runtime.databasePort)
  ); attempt += 1) await delay(125);
  assert(!isProcessRunning(application.pid), "Installed AI renderer process remained after shutdown.");
  assert(
    !await isPortOpen(runtime.apiPort)
      && !await isPortOpen(runtime.webPort)
      && !await isPortOpen(runtime.databasePort),
    "Installed AI runtime ports remained open after shutdown."
  );
  console.log(`Windows installed AI workbench passed: STT review/send, summary, TTS media, layout, cleanup, and screenshot ${screenshotPath}`);
} finally {
  await Promise.race([cdp?.send("Browser.close").catch(() => undefined) ?? Promise.resolve(), delay(1_000)]);
  cdp?.close();
  if (isProcessRunning(application.pid)) {
    try { execFileSync("taskkill.exe", ["/PID", String(application.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { application.kill(); }
  }
  const dataDirectory = path.join(userDataRoot, "postgres-data");
  const pgCtl = path.join(path.dirname(executablePath), "resources", "runtime", "postgres", "bin", "pg_ctl.exe");
  if (await pathExists(path.join(dataDirectory, "postmaster.pid"))) {
    try { execFileSync(pgCtl, ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { stdio: "ignore" }); }
    catch {
      if (runtime?.databasePort && await isPortOpen(runtime.databasePort)) throw new Error("Failed to stop installed AI PostgreSQL.");
    }
  }
  const resolvedTempRoot = path.resolve(tempRoot);
  assert(resolvedTempRoot.startsWith(path.resolve(os.tmpdir()) + path.sep), "Refusing to remove an AI renderer path outside temp.");
  await rm(resolvedTempRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
  assert(!await pathExists(resolvedTempRoot), "Installed AI renderer temporary directory remained after cleanup.");
}
