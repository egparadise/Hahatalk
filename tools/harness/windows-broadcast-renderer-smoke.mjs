import { execFileSync, spawn } from "node:child_process";
import dgram from "node:dgram";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RoomServiceClient } from "livekit-server-sdk";

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
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

async function startLiveKit(executable) {
  const signalPort = await availableTcpPort();
  const tcpPort = await availableTcpPort();
  const udpPort = await availableUdpPort();
  const logs = [];
  const child = spawn(executable, [
    "--dev",
    "--bind", "127.0.0.1",
    "--node-ip", "127.0.0.1",
    "--port", String(signalPort),
    "--rtc.tcp_port", String(tcpPort),
    "--udp-port", String(udpPort)
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const url = `http://127.0.0.1:${signalPort}`;
  const client = new RoomServiceClient(url, "devkey", "secret", { failover: false, requestTimeout: 1 });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`LiveKit exited during broadcast renderer setup.\n${logs.join("")}`);
    try {
      await client.listRooms();
      return { child, client, logs, url };
    } catch {
      await delay(100);
    }
  }
  child.kill();
  throw new Error(`LiveKit did not become ready.\n${logs.join("")}`);
}

async function waitForRuntime(statusPath, expectedPid) {
  for (let attempt = 0; attempt < 220; attempt += 1) {
    try {
      const status = JSON.parse(await readFile(statusPath, "utf8"));
      if (status.pid === expectedPid && status.rendererReady && status.rendererApiHealthy) return status;
    } catch {
      // Runtime status is created and enriched during startup.
    }
    await delay(250);
  }
  throw new Error("Installed broadcast renderer did not become ready.");
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
  throw new Error("Installed broadcast renderer CDP target did not become ready.");
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
  socket.addEventListener("close", () => {
    for (const handler of pending.values()) handler.reject(new Error("CDP connection closed."));
    pending.clear();
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
  assert((await readFile(outputPath)).length > 20_000, "Installed broadcast screenshot is unexpectedly small.");
}

async function signup(runtime, email, password, displayName, characterId) {
  const response = await fetch(`${runtime.apiUrl}/auth/signup`, {
    body: JSON.stringify({ characterId, displayName, email, password }),
    headers: { "Content-Type": "application/json", "Origin": runtime.webUrl, "X-HahaTalk-Client": "web-v1" },
    method: "POST",
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  assert(response.status === 201, `Installed broadcast user claim failed: ${response.status} ${text}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "Installed broadcast user claim did not return a session cookie.");
  return { body: JSON.parse(text), cookie };
}

async function apiRequest(runtime, cookie, pathName, { method = "GET", payload } = {}) {
  const response = await fetch(`${runtime.apiUrl}${pathName}`, {
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    headers: {
      "Cookie": cookie,
      ...(payload !== undefined ? { "Content-Type": "application/json", "Origin": runtime.webUrl, "X-HahaTalk-Client": "web-v1" } : {})
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
      const loginButton = [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '로그인');
      loginButton?.click();
    })()
  `);
  await waitForExpression(cdp, "document.body.innerText.includes('HahaTalk 로그인')", "Installed login form did not open.");
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
  await waitForExpression(cdp, "document.querySelector('.app-shell') !== null", "Installed viewer login did not reach the app.");
}

async function providerParticipant(roomClient, predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rooms = await roomClient.listRooms();
    if (rooms[0]) {
      const participants = await roomClient.listParticipants(rooms[0].name);
      const participant = participants.find(predicate);
      if (participant) return { participant, room: rooms[0], participants };
    }
    await delay(125);
  }
  throw new Error(message);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3_000)]);
  if (child.exitCode === null && child.pid) {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { child.kill(); }
  }
}

const desktopPackage = JSON.parse(await readFile(path.join(process.cwd(), "apps", "desktop", "package.json"), "utf8"));
const executablePath = path.resolve(argument(
  "executable",
  path.join(process.env.LOCALAPPDATA ?? "", "HahaTalk", `app-${desktopPackage.version}`, "HahaTalk.exe")
));
const screenshotPath = path.resolve(argument(
  "screenshot",
  path.join(process.cwd(), "apps", "desktop", "out", "stage7-personal-broadcast.png")
));
const livekitExecutable = path.join(process.env.LOCALAPPDATA ?? "", "HahaTalkDev", "LiveKit", "1.13.3", "livekit-server.exe");
const ownerPassword = "Stage7!BroadcastOwner";
const viewerPassword = "Stage7!BroadcastViewer";
const tempRoot = path.resolve(await mkdtemp(path.join(os.tmpdir(), "hahatalk-broadcast-renderer-")));
assert(tempRoot.startsWith(path.resolve(os.tmpdir()) + path.sep), "Broadcast renderer directory escaped system temp.");
const userDataRoot = path.join(tempRoot, "HahaTalk");
const statusPath = path.join(userDataRoot, "runtime-status.json");
const debugPort = await availableTcpPort();
await access(executablePath);
await access(livekitExecutable);

const livekit = await startLiveKit(livekitExecutable);
const application = spawn(executablePath, [`--remote-debugging-port=${debugPort}`], {
  env: {
    ...process.env,
    HAHATALK_TEST_FAKE_MEDIA: "1",
    HAHATALK_USER_DATA_DIR: userDataRoot,
    LIVEKIT_API_KEY: "devkey",
    LIVEKIT_API_SECRET: "secret",
    LIVEKIT_URL: livekit.url
  },
  stdio: "ignore",
  windowsHide: true
});
let cdp;
let runtime;
try {
  runtime = await waitForRuntime(statusPath, application.pid);
  const owner = await signup(runtime, "you@inviz.co.kr", ownerPassword, "Broadcast Host", "char-calm-lead");
  const viewer = await signup(runtime, "mina@inviz.co.kr", viewerPassword, "Broadcast Viewer", "char-focus-maker");
  const channel = await apiRequest(runtime, owner.cookie, "/broadcasts/channels", {
    method: "POST",
    payload: {
      description: "설치본 숨김 시청자와 진행 권한 검증",
      handle: `stage7-${Date.now()}`,
      name: "설치본 서비스 방송",
      visibility: "organization"
    }
  });
  await apiRequest(runtime, viewer.cookie, `/broadcasts/channels/${channel.id}/subscribe`, {
    method: "POST",
    payload: { notificationLevel: "live_only" }
  });
  const scheduled = await apiRequest(runtime, owner.cookie, `/broadcasts/channels/${channel.id}/sessions`, {
    method: "POST",
    payload: {
      callType: "video",
      chatMode: "moderated",
      clientSessionId: `renderer-broadcast-${Date.now()}`,
      description: "질문 검수와 비공개 시청자 방송",
      expectedEndAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      replayRequested: true,
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      title: "설치본 개인 방송 검증",
      viewerLimit: 30
    }
  });
  await apiRequest(runtime, owner.cookie, `/broadcasts/sessions/${scheduled.id}/start`, {
    method: "POST",
    payload: { version: scheduled.version }
  });

  const target = await waitForDebugTarget(debugPort);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await loginRenderer(cdp, "mina@inviz.co.kr", viewerPassword);
  await evaluate(cdp, "document.querySelector('button[title=\"방송\"]').click()");
  await waitForExpression(cdp, "document.querySelector('.broadcast-shell') !== null", "Installed broadcast desk did not open.", 200);
  await waitForExpression(cdp, "document.querySelector('.broadcast-workspace')?.innerText.includes('설치본 개인 방송 검증')", "Installed live broadcast did not render.", 200);
  assert(!(await evaluate(cdp, "document.body.innerText.includes('참여자 운영')")), "Viewer renderer exposed broadcast participant operations.");
  await evaluate(cdp, "[...document.querySelectorAll('.broadcast-command')].find((button) => button.innerText.includes('시청하기')).click()");
  await waitForExpression(cdp, "document.querySelector('.broadcast-stage[data-phase=\"active\"]') !== null", "Installed viewer did not connect to the live broadcast.", 260);

  const hiddenViewer = await providerParticipant(
    livekit.client,
    (participant) => participant.permission?.hidden === true && participant.permission?.canSubscribe === true && participant.permission?.canPublish === false,
    "Installed viewer did not reach hidden subscribe-only provider state."
  );
  assert(hiddenViewer.participant.identity !== viewer.body.user.id, "Broadcast exposed a stable app identity to LiveKit.");
  const viewerProjection = await apiRequest(runtime, viewer.cookie, `/broadcasts/sessions/${scheduled.id}`);
  assert(!("moderationParticipants" in viewerProjection), "Viewer API projection exposed the broadcast roster.");
  assert(viewerProjection.onStageParticipants.every((participant) => participant.role !== "viewer"), "Viewer API projection exposed another viewer.");

  await evaluate(cdp, `
    (() => {
      [...document.querySelectorAll('.broadcast-kind-control button')]
        .find((button) => button.innerText.includes('질문')).click();
      const input = document.querySelector('.broadcast-composer textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, '설치본에서 보낸 비공개 질문입니다.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.closest('form').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, "document.querySelector('.broadcast-message-row[data-status=\"pending\"]')?.innerText.includes('설치본에서 보낸 비공개 질문')", "Viewer question did not enter the moderation queue.", 160);
  let hostView = await apiRequest(runtime, owner.cookie, `/broadcasts/sessions/${scheduled.id}`);
  const question = hostView.messages.find((message) => message.body.includes("설치본에서 보낸 비공개 질문"));
  assert(question?.status === "pending", "Host did not receive the pending viewer question.");
  await apiRequest(runtime, owner.cookie, `/broadcasts/sessions/${scheduled.id}/messages/${question.id}/moderate`, {
    method: "PATCH",
    payload: { action: "publish", version: question.version }
  });
  await waitForExpression(cdp, "document.querySelector('.broadcast-message-row[data-status=\"published\"]')?.innerText.includes('설치본에서 보낸 비공개 질문')", "Published viewer question did not update in real time.", 200);
  await evaluate(cdp, "document.querySelector('.broadcast-reactions button[title=\"좋아요\"]').click()");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const next = await apiRequest(runtime, viewer.cookie, `/broadcasts/sessions/${scheduled.id}`);
    if (next.reactionCounts.some((item) => item.reaction === "like" && item.count === 1)) break;
    if (attempt === 99) throw new Error("Installed broadcast reaction did not persist.");
    await delay(100);
  }

  hostView = await apiRequest(runtime, owner.cookie, `/broadcasts/sessions/${scheduled.id}`);
  await apiRequest(runtime, owner.cookie, `/broadcasts/sessions/${scheduled.id}/participants/${encodeURIComponent(viewer.body.user.id)}/role`, {
    method: "PATCH",
    payload: { role: "speaker", version: hostView.version }
  });
  await providerParticipant(
    livekit.client,
    (participant) => participant.identity === hiddenViewer.participant.identity && participant.permission?.hidden === false && participant.permission?.canPublish === true,
    "Promoted viewer did not receive visible publisher permissions."
  );
  await waitForExpression(cdp, "document.querySelector('.broadcast-round-control[title=\"카메라 켜기\"]') !== null", "Promoted viewer did not receive speaker controls.", 200);
  await evaluate(cdp, "document.querySelector('.broadcast-round-control[title=\"카메라 켜기\"]').click()");
  await waitForExpression(cdp, "document.querySelector('.broadcast-video-tile[data-self=\"true\"] video')?.videoWidth > 0", "Promoted speaker fake camera did not render.", 240);
  await providerParticipant(
    livekit.client,
    (participant) => participant.identity === hiddenViewer.participant.identity && (participant.tracks?.length ?? 0) > 0,
    "Promoted speaker did not publish a provider track."
  );

  hostView = await apiRequest(runtime, owner.cookie, `/broadcasts/sessions/${scheduled.id}`);
  await apiRequest(runtime, owner.cookie, `/broadcasts/sessions/${scheduled.id}/participants/${encodeURIComponent(viewer.body.user.id)}/role`, {
    method: "PATCH",
    payload: { role: "viewer", version: hostView.version }
  });
  const demotedViewer = await providerParticipant(
    livekit.client,
    (participant) => participant.identity === hiddenViewer.participant.identity && participant.permission?.hidden === true && participant.permission?.canPublish === false,
    "Demoted speaker did not return to hidden subscribe-only permissions."
  );
  assert((demotedViewer.participant.tracks?.length ?? 0) === 0, "Demoted viewer retained a published track.");
  await waitForExpression(cdp, "!document.querySelector('.broadcast-round-control') && !document.querySelector('.broadcast-video-tile[data-self=\"true\"]')", "Demoted viewer retained publisher controls or local video.", 200);

  const layout = await evaluate(cdp, `
    (() => {
      const shell = document.querySelector('.broadcast-shell').getBoundingClientRect();
      const workspace = document.querySelector('.broadcast-workspace').getBoundingClientRect();
      const header = document.querySelector('.broadcast-workspace-header').getBoundingClientRect();
      const stage = document.querySelector('.broadcast-stage').getBoundingClientRect();
      const controls = document.querySelector('.broadcast-control-bar').getBoundingClientRect();
      return {
        controlsVisible: controls.bottom <= innerHeight + 1 && controls.height >= 60,
        noOverlap: header.bottom <= stage.top + 1 && stage.bottom <= controls.top + 1,
        shellVisible: shell.width >= 1000 && shell.height >= 650,
        stageVisible: stage.width >= 500 && stage.height >= 350,
        withinWorkspace: stage.left >= workspace.left && stage.right <= workspace.right + 1
      };
    })()
  `);
  assert(layout.shellVisible && layout.stageVisible && layout.noOverlap && layout.controlsVisible && layout.withinWorkspace, "Installed broadcast layout overlaps or is clipped.");
  await captureScreenshot(cdp, screenshotPath);

  await evaluate(cdp, "[...document.querySelectorAll('.broadcast-command')].find((button) => button.innerText.includes('나가기')).click()");
  await waitForExpression(cdp, "document.querySelector('.broadcast-stage[data-phase=\"idle\"]') !== null", "Installed viewer did not leave the media session.", 160);
  const ending = await apiRequest(runtime, owner.cookie, `/broadcasts/sessions/${scheduled.id}`);
  const ended = await apiRequest(runtime, owner.cookie, `/broadcasts/sessions/${scheduled.id}/end`, {
    method: "POST",
    payload: { version: ending.version }
  });
  assert(ended.status === "ended" && ended.replay.status === "unavailable", "Broadcast replay did not fail closed without trusted egress.");
  for (let attempt = 0; attempt < 100 && (await livekit.client.listRooms()).length; attempt += 1) await delay(125);
  assert((await livekit.client.listRooms()).length === 0, "Installed broadcast provider room remained after end.");

  await Promise.race([cdp.send("Browser.close").catch(() => undefined), delay(1_000)]);
  for (let attempt = 0; attempt < 80 && isProcessRunning(application.pid); attempt += 1) await delay(125);
  assert(!isProcessRunning(application.pid), "Installed broadcast renderer process remained after shutdown.");
  assert(!(await isPortOpen(runtime.databasePort)), "Installed broadcast PostgreSQL remained reachable after shutdown.");
  console.log(`Windows installed personal broadcast passed: hidden viewer, moderated question, reaction, live role promotion/demotion, layout, replay boundary, and screenshot ${screenshotPath}`);
} finally {
  if (isProcessRunning(application.pid)) {
    await Promise.race([cdp?.send("Browser.close").catch(() => undefined) ?? Promise.resolve(), delay(1_000)]);
    for (let attempt = 0; attempt < 30 && isProcessRunning(application.pid); attempt += 1) await delay(150);
  }
  cdp?.close();
  if (isProcessRunning(application.pid)) {
    try { execFileSync("taskkill.exe", ["/PID", String(application.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { application.kill(); }
  }
  if (runtime?.databaseMode === "embedded-postgresql" && await isPortOpen(runtime.databasePort)) {
    const pgCtl = path.join(path.dirname(executablePath), "resources", "runtime", "postgres", "bin", "pg_ctl.exe");
    execFileSync(pgCtl, ["-D", path.join(userDataRoot, "postgres-data"), "-m", "fast", "-w", "stop"], { stdio: "ignore" });
  }
  await stopChild(livekit.child).catch(() => undefined);
  await rm(tempRoot, { force: true, recursive: true });
}
