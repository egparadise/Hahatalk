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
    if (child.exitCode !== null) throw new Error(`LiveKit exited during renderer setup.\n${logs.join("")}`);
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const status = JSON.parse(await readFile(statusPath, "utf8"));
      if (status.pid === expectedPid && status.rendererReady && status.rendererApiHealthy) return status;
    } catch {
      // Runtime status is created and enriched during startup.
    }
    await delay(250);
  }
  throw new Error("Installed call renderer did not become ready.");
}

async function waitForDebugTarget(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  throw new Error("Installed call renderer CDP target did not become ready.");
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

async function waitForExpression(cdp, expression, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await delay(125);
  }
  const body = await evaluate(cdp, "document.body.innerText").catch(() => "renderer text unavailable");
  throw new Error(`${message}\nRenderer text: ${String(body).slice(-1600)}`);
}

async function captureScreenshot(cdp, outputPath) {
  await cdp.send("Page.bringToFront");
  await evaluate(cdp, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await delay(400);
  const result = await cdp.send("Page.captureScreenshot", { captureBeyondViewport: false, format: "png", fromSurface: true });
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  assert((await readFile(outputPath)).length > 10_000, "Installed active call screenshot is unexpectedly small.");
}

async function signup(runtime, email, password, displayName, characterId) {
  const response = await fetch(`${runtime.apiUrl}/auth/signup`, {
    body: JSON.stringify({ characterId, displayName, email, password }),
    headers: { "Content-Type": "application/json", "Origin": runtime.webUrl, "X-HahaTalk-Client": "web-v1" },
    method: "POST",
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  assert(response.status === 201, `Installed call user claim failed: ${response.status} ${text}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "Installed call user claim did not return a session cookie.");
  return { body: JSON.parse(text), cookie };
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
  await waitForExpression(cdp, "Boolean(document.querySelector('button[title=\"로그아웃\"]'))", "Installed owner login did not reach chat.");
}

async function startCallAs(runtime, cookie, targetUserId) {
  const response = await fetch(`${runtime.apiUrl}/calls`, {
    body: JSON.stringify({
      callType: "video",
      clientCallId: `renderer-call-${Date.now()}`,
      spaceId: "00000000-0000-4000-8000-000000000203",
      targetUserIds: [targetUserId]
    }),
    headers: {
      "Content-Type": "application/json",
      "Cookie": cookie,
      "Origin": runtime.webUrl,
      "X-HahaTalk-Client": "web-v1"
    },
    method: "POST",
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  assert(response.status === 201, `Installed incoming call start failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

async function waitForParticipant(roomClient) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rooms = await roomClient.listRooms();
    if (rooms[0]) {
      const participants = await roomClient.listParticipants(rooms[0].name);
      if (participants.length === 1) return { participants, room: rooms[0] };
    }
    await delay(125);
  }
  throw new Error("Installed renderer did not join the actual LiveKit room.");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3_000)
  ]);
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
  path.join(process.cwd(), "apps", "desktop", "out", "stage6b-active-video-call.png")
));
const livekitExecutable = path.join(process.env.LOCALAPPDATA ?? "", "HahaTalkDev", "LiveKit", "1.13.3", "livekit-server.exe");
const password = "Stage6B!RendererOwner";
const minaPassword = "Stage6B!RendererMina";
const tempRoot = path.resolve(await mkdtemp(path.join(os.tmpdir(), "hahatalk-call-renderer-")));
const expectedTempRoot = path.resolve(os.tmpdir());
assert(tempRoot.startsWith(expectedTempRoot + path.sep), "Renderer test directory escaped the system temp directory.");
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
  const owner = await signup(runtime, "you@inviz.co.kr", password, "Call Renderer Owner", "char-calm-lead");
  const mina = await signup(runtime, "mina@inviz.co.kr", minaPassword, "Call Renderer Mina", "char-focus-maker");
  const target = await waitForDebugTarget(debugPort);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await loginRenderer(cdp, "you@inviz.co.kr", password);
  await waitForExpression(cdp, "document.querySelectorAll('.room-item').length === 3", "Installed rooms did not load before the call test.");

  const started = await startCallAs(runtime, mina.cookie, owner.body.user.id);
  assert(started.isCreator && started.status === "ringing", "Mina did not create the installed incoming call.");
  await waitForExpression(
    cdp,
    "document.querySelector('.call-desk[data-phase=\"waiting\"]')?.innerText.includes('받기')",
    "Installed renderer did not show the incoming call desk."
  );
  await evaluate(cdp, "[...document.querySelectorAll('.call-command')].find((button) => button.innerText.includes('받기')).click()");
  await waitForExpression(
    cdp,
    "document.querySelector('.call-desk[data-phase=\"active\"]') !== null",
    "Installed renderer did not connect the accepted call.",
    160
  );
  const providerState = await waitForParticipant(livekit.client);
  assert(providerState.participants[0].identity !== owner.body.user.id, "Installed renderer exposed the stable app user id to LiveKit.");
  await waitForExpression(
    cdp,
    "document.querySelector('.call-video')?.videoWidth > 0 && document.querySelector('.call-video')?.videoHeight > 0",
    "Fake camera frames did not render in the installed call desk.",
    160
  );
  const layout = await evaluate(cdp, `
    (() => {
      const desk = document.querySelector('.call-desk').getBoundingClientRect();
      const header = document.querySelector('.call-desk-header').getBoundingClientRect();
      const controls = document.querySelector('.call-controls').getBoundingClientRect();
      const tile = document.querySelector('.call-media-tile').getBoundingClientRect();
      return {
        deskVisible: desk.width > 500 && desk.height > 400,
        noVerticalOverlap: header.bottom <= tile.top && tile.bottom <= controls.top,
        controlsVisible: controls.bottom <= innerHeight + 1,
        text: document.querySelector('.call-desk').innerText
      };
    })()
  `);
  assert(layout.deskVisible && layout.noVerticalOverlap && layout.controlsVisible, "Installed call layout overlaps or is clipped.");
  assert(layout.text.includes("Call Renderer Mina") && layout.text.includes("Call Renderer Owner"), "Installed call labels are incomplete.");

  await evaluate(cdp, "document.querySelector('button[title=\"마이크 끄기\"]').click()");
  await waitForExpression(cdp, "document.querySelector('button[title=\"마이크 켜기\"]') !== null", "Installed microphone toggle did not update.");
  await evaluate(cdp, "document.querySelector('button[title=\"마이크 켜기\"]').click()");
  await waitForExpression(cdp, "document.querySelector('button[title=\"마이크 끄기\"]') !== null", "Installed microphone did not turn back on.");
  await captureScreenshot(cdp, screenshotPath);

  await evaluate(cdp, "document.querySelector('button[title=\"통화 나가기\"]').click()");
  await waitForExpression(cdp, "document.querySelector('.call-desk[data-phase=\"ended\"]') !== null", "Installed participant leave did not end the call.");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await livekit.client.listRooms()).length === 0) break;
    await delay(125);
  }
  assert((await livekit.client.listRooms()).length === 0, "Installed call provider room remained after the last participant left.");
  await Promise.race([
    cdp.send("Browser.close").catch(() => undefined),
    delay(1_000)
  ]);
  for (let attempt = 0; attempt < 80 && isProcessRunning(application.pid); attempt += 1) await delay(125);
  assert(!isProcessRunning(application.pid), "Installed call renderer process remained after shutdown.");
  assert(!(await isPortOpen(runtime.databasePort)), "Installed call renderer PostgreSQL remained reachable after shutdown.");
  console.log(`Windows installed LiveKit renderer passed: incoming UI, real SFU join, fake camera, mic toggle, leave, layout, and screenshot ${screenshotPath}`);
} finally {
  if (isProcessRunning(application.pid)) {
    await Promise.race([
      cdp?.send("Browser.close").catch(() => undefined) ?? Promise.resolve(),
      delay(1_000)
    ]);
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
