import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

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
  try { await access(candidatePath); return true; } catch { return false; }
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
  throw new Error("Installed remote support renderer did not become ready.");
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
  throw new Error("Installed remote support renderer CDP target did not become ready.");
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

async function waitForExpression(cdp, expression, message, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await delay(125);
  }
  const body = await evaluate(cdp, "document.body.innerText").catch(() => "renderer text unavailable");
  throw new Error(`${message}\nRenderer text: ${String(body).slice(-2600)}`);
}

async function captureScreenshot(cdp, outputPath) {
  await cdp.send("Page.bringToFront");
  await evaluate(cdp, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await delay(500);
  const result = await cdp.send("Page.captureScreenshot", { captureBeyondViewport: false, format: "png", fromSurface: true });
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  assert((await readFile(outputPath)).length > 20_000, "Installed remote support screenshot is unexpectedly small.");
}

async function signup(runtime, email, password, displayName, characterId) {
  const response = await fetch(`${runtime.apiUrl}/auth/signup`, {
    body: JSON.stringify({ characterId, displayName, email, password }),
    headers: { "Content-Type": "application/json", Origin: runtime.webUrl, "X-HahaTalk-Client": "web-v1" },
    method: "POST",
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  assert(response.status === 201, `Installed remote support user claim failed: ${response.status} ${text}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "Installed remote support user claim did not return a cookie.");
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

async function loginRenderer(cdp, email, password) {
  await evaluate(cdp, `
    (() => {
      [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '로그인')?.click();
    })()
  `);
  await waitForExpression(cdp, "document.body.innerText.includes('HahaTalk 로그인')", "Installed remote support login form did not open.");
  await evaluate(cdp, `
    (() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const setValue = (input, value) => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(document.querySelector('input[type="email"]'), ${JSON.stringify(email)});
      setValue(document.querySelector('input[type="password"]'), ${JSON.stringify(password)});
      document.querySelector('form').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, "document.querySelector('.app-shell') !== null", "Installed remote support login did not reach the app.");
}

async function seedPrivateCall(database, callId) {
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const spaceId = "00000000-0000-4000-8000-000000000201";
  const ownerId = "00000000-0000-4000-8000-000000000101";
  const targetId = "00000000-0000-4000-8000-000000000102";
  await database.query(
    `insert into call_sessions (
       id, organization_id, space_id, created_by, call_type, provider_room_name,
       status, expires_at, started_at
     ) values ($1, $2, $3, $4, 'video', $5, 'active', now() + interval '2 hours', now())`,
    [callId, organizationId, spaceId, ownerId, `hht_call_renderer_${callId.replaceAll("-", "")}`]
  );
  await database.query(
    `insert into call_participants (
       call_session_id, user_id, role, status, provider_identity,
       can_publish_audio, can_publish_video, joined_at, screen_share_status
     ) values ($1, $2, 'host', 'joined', $3, true, true, now(), 'off')`,
    [callId, ownerId, `hht_media_renderer_owner_${callId.replaceAll("-", "")}`]
  );
  await database.query(
    `insert into call_participants (
       call_session_id, user_id, role, status, provider_identity,
       can_publish_audio, can_publish_video, joined_at, screen_share_status,
       screen_share_requested_at, screen_share_started_at
     ) values ($1, $2, 'participant', 'joined', $3, true, true, now(), 'active', now(), now())`,
    [callId, targetId, `hht_media_renderer_target_${callId.replaceAll("-", "")}`]
  );
}

const desktopPackage = JSON.parse(await readFile(path.join(process.cwd(), "apps", "desktop", "package.json"), "utf8"));
const executablePath = path.resolve(argument(
  "executable",
  path.join(process.env.LOCALAPPDATA ?? "", "HahaTalk", `app-${desktopPackage.version}`, "HahaTalk.exe")
));
const screenshotPath = path.resolve(argument(
  "screenshot",
  path.join(process.cwd(), "apps", "desktop", "out", "stage9-consented-remote-support.png")
));
const ownerPassword = "Stage9!RendererOwner";
const targetPassword = "Stage9!RendererTarget";
const tempRoot = path.resolve(await mkdtemp(path.join(os.tmpdir(), "hahatalk-remote-renderer-")));
assert(tempRoot.startsWith(path.resolve(os.tmpdir()) + path.sep), "Remote renderer directory escaped system temp.");
const userDataRoot = path.join(tempRoot, "HahaTalk");
const statusPath = path.join(userDataRoot, "runtime-status.json");
const debugPort = await availablePort();
await access(executablePath);

const application = spawn(executablePath, [`--remote-debugging-port=${debugPort}`], {
  env: { ...process.env, HAHATALK_USER_DATA_DIR: userDataRoot },
  stdio: "ignore",
  windowsHide: true
});
let cdp;
let runtime;
let database;
try {
  runtime = await waitForRuntime(statusPath, application.pid);
  const owner = await signup(runtime, "you@inviz.co.kr", ownerPassword, "Remote Support Owner", "char-calm-lead");
  const targetUser = await signup(runtime, "mina@inviz.co.kr", targetPassword, "Remote Support Target", "char-focus-maker");
  const credentials = JSON.parse(await readFile(path.join(userDataRoot, "postgres-credentials.json"), "utf8"));
  database = new Client({
    connectionString: `postgresql://${credentials.user}:${encodeURIComponent(credentials.password)}@127.0.0.1:${runtime.databasePort}/hahatalk`
  });
  await database.connect();
  const callId = randomUUID();
  await seedPrivateCall(database, callId);
  const requested = await apiRequest(runtime, owner.cookie, "/remote-support", {
    method: "POST",
    payload: {
      callId,
      clientRequestId: `renderer-remote-${randomUUID()}`,
      requestedScopes: ["screen_view", "remote_control"],
      spaceId: owner.body.roomId,
      targetUserId: targetUser.body.user.id
    }
  });
  const capabilities = await apiRequest(runtime, targetUser.cookie, "/remote-support/capabilities");
  await apiRequest(runtime, targetUser.cookie, `/remote-support/${requested.id}/consents`, {
    method: "POST",
    payload: { decision: "granted", policyVersion: capabilities.policyVersion, scope: "screen_view" }
  });
  await apiRequest(runtime, targetUser.cookie, `/remote-support/${requested.id}/consents`, {
    method: "POST",
    payload: { decision: "granted", policyVersion: capabilities.policyVersion, scope: "remote_control" }
  });

  const target = await waitForDebugTarget(debugPort);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 900, mobile: false, width: 1440 });
  await loginRenderer(cdp, "mina@inviz.co.kr", targetPassword);
  await evaluate(cdp, `document.querySelector('button[title="원격 지원"]').click()`);
  await waitForExpression(cdp, "document.querySelector('.remote-support-workbench') !== null", "Installed remote support panel did not open.");
  await waitForExpression(cdp, "document.body.innerText.includes('에이전트 시작')", "Approved remote support session did not render.");
  await evaluate(cdp, `
    [...document.querySelectorAll('.remote-session-actions button')]
      .find((button) => button.textContent.includes('에이전트 시작')).click()
  `);
  try {
    await waitForExpression(
      cdp,
      "window.hahaTalkDesktop.remoteSupport.status().then((status) => status.state === 'online')",
      "Installed utility agent did not become online.",
      240
    );
  } catch (error) {
    const status = await evaluate(cdp, "window.hahaTalkDesktop.remoteSupport.status()").catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nAgent status: ${JSON.stringify(status)}`);
  }

  const command = await apiRequest(runtime, owner.cookie, `/remote-support/${requested.id}/commands`, {
    method: "POST",
    payload: {
      clientCommandId: `renderer-command-${randomUUID()}`,
      kind: "key",
      payload: { action: "press", code: "Enter" }
    }
  });
  let completed;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const session = await apiRequest(runtime, owner.cookie, `/remote-support/${requested.id}`);
    if (session.latestCommand?.id === command.id && session.latestCommand.status === "simulated") {
      completed = session;
      break;
    }
    await delay(125);
  }
  assert(completed, "Installed utility agent did not acknowledge the dry-run command.");
  await waitForExpression(cdp, "document.body.innerText.includes('unsigned_agent_dry_run')", "Dry-run command result did not render.", 240);

  const geometry = await evaluate(cdp, `
    (() => {
      const panel = document.querySelector('.right-panel').getBoundingClientRect();
      const workbench = document.querySelector('.remote-support-workbench').getBoundingClientRect();
      const controls = document.querySelector('.remote-session-detail').getBoundingClientRect();
      return {
        controlsFit: controls.left >= panel.left && controls.right <= panel.right,
        panel: { left: panel.left, right: panel.right, width: panel.width },
        viewport: { height: innerHeight, width: innerWidth },
        workbench: { left: workbench.left, right: workbench.right, width: workbench.width }
      };
    })()
  `);
  assert(geometry.controlsFit && geometry.panel.right <= geometry.viewport.width, `Remote support panel escaped viewport: ${JSON.stringify(geometry)}`);
  assert(geometry.workbench.width <= geometry.panel.width, `Remote support workbench overlaps its panel: ${JSON.stringify(geometry)}`);
  await captureScreenshot(cdp, screenshotPath);

  await evaluate(cdp, `
    [...document.querySelectorAll('.remote-session-actions button')]
      .find((button) => button.textContent.includes('일시정지')).click()
  `);
  await waitForExpression(cdp, "document.body.innerText.includes('일시정지')", "Target pause state did not render.");
  await waitForExpression(
    cdp,
    "window.hahaTalkDesktop.remoteSupport.status().then((status) => status.state === 'stopped')",
    "Installed utility agent remained active after target pause."
  );
  const paused = await apiRequest(runtime, targetUser.cookie, `/remote-support/${requested.id}`);
  assert(paused.status === "paused" && paused.controlEpoch === 2, "Installed target pause did not fence remote input.");

  await database.end();
  database = undefined;
  await Promise.race([cdp.send("Browser.close").catch(() => undefined), delay(1_000)]);
  for (let attempt = 0; attempt < 120 && (
    isProcessRunning(application.pid)
    || await isPortOpen(runtime.databasePort)
  ); attempt += 1) await delay(125);
  assert(!isProcessRunning(application.pid), "Installed remote support renderer process remained after shutdown.");
  assert(!await isPortOpen(runtime.databasePort), "Installed remote support PostgreSQL remained open after shutdown.");
  console.log(`Windows installed remote support passed: panel, Electron utility agent activation, dry-run command round trip, target pause fencing, layout, cleanup, and screenshot ${screenshotPath}`);
} finally {
  await database?.end().catch(() => undefined);
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
      if (runtime?.databasePort && await isPortOpen(runtime.databasePort)) throw new Error("Failed to stop installed remote support PostgreSQL.");
    }
  }
  const resolvedTempRoot = path.resolve(tempRoot);
  assert(resolvedTempRoot.startsWith(path.resolve(os.tmpdir()) + path.sep), "Refusing to remove a remote renderer path outside temp.");
  await rm(resolvedTempRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
  assert(!await pathExists(resolvedTempRoot), "Installed remote support renderer temporary directory remained after cleanup.");
}
