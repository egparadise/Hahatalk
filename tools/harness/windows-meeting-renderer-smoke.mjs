import { execFileSync, spawn } from "node:child_process";
import dgram from "node:dgram";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RoomServiceClient, TrackSource } from "livekit-server-sdk";

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
    if (child.exitCode !== null) throw new Error(`LiveKit exited during meeting renderer setup.\n${logs.join("")}`);
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const status = JSON.parse(await readFile(statusPath, "utf8"));
      if (status.pid === expectedPid && status.rendererReady && status.rendererApiHealthy) return status;
    } catch {
      // Runtime status is created and enriched during startup.
    }
    await delay(250);
  }
  throw new Error("Installed meeting renderer did not become ready.");
}

async function waitForDebugTarget(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
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
  throw new Error("Installed meeting renderer CDP target did not become ready.");
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

async function waitForExpression(cdp, expression, message, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await delay(125);
  }
  const body = await evaluate(cdp, "document.body.innerText").catch(() => "renderer text unavailable");
  throw new Error(`${message}\nRenderer text: ${String(body).slice(-2000)}`);
}

async function captureScreenshot(cdp, outputPath) {
  await cdp.send("Page.bringToFront");
  await evaluate(cdp, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await delay(500);
  const result = await cdp.send("Page.captureScreenshot", { captureBeyondViewport: false, format: "png", fromSurface: true });
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  assert((await readFile(outputPath)).length > 10_000, "Installed meeting screenshot is unexpectedly small.");
}

async function signup(runtime, email, password, displayName, characterId) {
  const response = await fetch(`${runtime.apiUrl}/auth/signup`, {
    body: JSON.stringify({ characterId, displayName, email, password }),
    headers: { "Content-Type": "application/json", "Origin": runtime.webUrl, "X-HahaTalk-Client": "web-v1" },
    method: "POST",
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  assert(response.status === 201, `Installed meeting user claim failed: ${response.status} ${text}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie, "Installed meeting user claim did not return a session cookie.");
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
  await waitForExpression(cdp, "Boolean(document.querySelector('button[title=\"로그아웃\"]'))", "Installed participant login did not reach chat.");
}

function localInZone(date, timeZone = "Asia/Seoul") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

async function waitForProviderParticipant(roomClient, canPublish) {
  for (let attempt = 0; attempt < 140; attempt += 1) {
    const rooms = await roomClient.listRooms();
    if (rooms[0]) {
      const participants = await roomClient.listParticipants(rooms[0].name);
      const participant = participants[0];
      if (participant && participant.permission?.canPublish === canPublish) return { participant, room: rooms[0] };
    }
    await delay(125);
  }
  throw new Error(`Installed meeting participant did not reach canPublish=${canPublish}.`);
}

async function waitForMeetingScreenShare(roomClient, expected) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const rooms = await roomClient.listRooms();
    if (rooms[0]) {
      const participants = await roomClient.listParticipants(rooms[0].name);
      const participant = participants[0];
      const hasTrack = participant?.tracks?.some((track) => track.source === TrackSource.SCREEN_SHARE) ?? false;
      const hasPermission = participant?.permission?.canPublishSources?.includes(TrackSource.SCREEN_SHARE) ?? false;
      if (participant && hasTrack === expected && hasPermission === expected) return participant;
    }
    await delay(125);
  }
  throw new Error(`Installed meeting screen share did not reach expected=${expected}.`);
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
  path.join(process.cwd(), "apps", "desktop", "out", "stage6c-scheduled-meeting-role.png")
));
const livekitExecutable = path.join(process.env.LOCALAPPDATA ?? "", "HahaTalkDev", "LiveKit", "1.13.3", "livekit-server.exe");
const ownerPassword = "Stage6C!RendererOwner";
const minaPassword = "Stage6C!RendererMina";
const tempRoot = path.resolve(await mkdtemp(path.join(os.tmpdir(), "hahatalk-meeting-renderer-")));
const expectedTempRoot = path.resolve(os.tmpdir());
assert(tempRoot.startsWith(expectedTempRoot + path.sep), "Meeting renderer test directory escaped system temp.");
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
  const owner = await signup(runtime, "you@inviz.co.kr", ownerPassword, "Meeting Renderer Owner", "char-calm-lead");
  const mina = await signup(runtime, "mina@inviz.co.kr", minaPassword, "Meeting Renderer Mina", "char-focus-maker");
  const now = new Date();
  const startsAt = new Date(now.getTime() + 10 * 60_000);
  const endsAt = new Date(now.getTime() + 70 * 60_000);
  const event = await apiRequest(runtime, owner.cookie, "/calendar/events", {
    method: "POST",
    payload: {
      allDay: false,
      attendeeIds: [mina.body.user.id],
      description: "Installed meeting renderer role verification",
      endsLocal: localInZone(endsAt),
      location: "Renderer meeting room",
      reminderOffsetsMinutes: [],
      spaceId: "00000000-0000-4000-8000-000000000203",
      startsLocal: localInZone(startsAt),
      timezone: "Asia/Seoul",
      title: "설치본 역할 검증 회의",
      visibility: "attendees"
    }
  });
  await apiRequest(runtime, mina.cookie, `/calendar/events/${event.id}/rsvp`, { method: "POST", payload: { response: "accepted" } });
  const meeting = await apiRequest(runtime, owner.cookie, "/meetings", {
    method: "POST",
    payload: {
      callType: "video",
      clientMeetingId: `renderer-meeting-${Date.now()}`,
      eventId: event.id,
      occurrenceStartsAt: event.startsAt,
      roleAssignments: [{ role: "speaker", userId: mina.body.user.id }]
    }
  });
  await apiRequest(runtime, owner.cookie, `/meetings/${meeting.id}/open`, { method: "POST", payload: { version: meeting.version } });

  const target = await waitForDebugTarget(debugPort);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await loginRenderer(cdp, "mina@inviz.co.kr", minaPassword);
  await evaluate(cdp, "document.querySelector('button[title=\"일정\"]').click()");
  await waitForExpression(cdp, "document.querySelector('.calendar-shell') !== null", "Installed calendar desk did not open.", 160);
  await waitForExpression(cdp, "[...document.querySelectorAll('.calendar-event-pill')].some((button) => button.innerText.includes('설치본 역할 검증 회의'))", "Installed event did not render in the calendar.", 160);
  await evaluate(cdp, "[...document.querySelectorAll('.calendar-event-pill')].find((button) => button.innerText.includes('설치본 역할 검증 회의')).click()");
  await waitForExpression(cdp, "[...document.querySelectorAll('.meeting-lobby button')].some((button) => button.innerText.includes('대기실 입장'))", "Meeting lobby did not show participant entry.", 160);
  await evaluate(cdp, "[...document.querySelectorAll('.meeting-lobby button')].find((button) => button.innerText.includes('대기실 입장')).click()");
  await waitForExpression(cdp, "document.querySelector('.meeting-lobby')?.innerText.includes('승인 대기')", "Participant did not enter waiting state.");

  const admitted = await apiRequest(runtime, owner.cookie, `/meetings/${meeting.id}/participants/${encodeURIComponent(mina.body.user.id)}/admit`, { method: "POST", payload: {} });
  assert(admitted.participants.find((participant) => participant.person.id === mina.body.user.id)?.status === "admitted", "Host admission did not persist on the server.");
  await waitForExpression(cdp, "[...document.querySelectorAll('.meeting-lobby button')].some((button) => button.innerText.includes('회의 참가'))", "Admitted participant did not receive the join command.", 160);
  await evaluate(cdp, "[...document.querySelectorAll('.meeting-lobby button')].find((button) => button.innerText.includes('회의 참가')).click()");
  await waitForExpression(cdp, "document.querySelector('.meeting-room[data-phase=\"active\"]') !== null", "Installed participant did not connect to the meeting.", 220);
  const publisher = await waitForProviderParticipant(livekit.client, true);
  assert(publisher.participant.identity !== mina.body.user.id, "Installed meeting exposed stable app identity to LiveKit.");
  assert(!publisher.participant.permission?.canPublishSources?.includes(TrackSource.SCREEN_SHARE), "Initial meeting permission included screen sharing.");
  await waitForExpression(cdp, "document.querySelector('.meeting-room .call-video')?.videoWidth > 0", "Fake camera did not render in the installed meeting.", 180);

  await evaluate(cdp, "document.querySelector('.meeting-room button[title=\"화면 공유\"]').click()");
  await waitForExpression(
    cdp,
    "document.querySelector('.meeting-room .screen-share-stage .call-video')?.videoWidth > 0",
    "Installed speaker could not publish a scheduled-meeting screen.",
    240
  );
  await waitForMeetingScreenShare(livekit.client, true);
  const sharingMeeting = await apiRequest(runtime, mina.cookie, `/meetings/${meeting.id}`);
  assert(sharingMeeting.participants.find((participant) => participant.isSelf)?.screenShareStatus === "active", "Scheduled meeting did not persist the active speaker share.");

  const current = await apiRequest(runtime, owner.cookie, `/meetings/${meeting.id}`);
  await apiRequest(runtime, owner.cookie, `/meetings/${meeting.id}/participants/${encodeURIComponent(mina.body.user.id)}/role`, {
    method: "PATCH",
    payload: { role: "attendee", version: current.version }
  });
  const attendeeState = await waitForProviderParticipant(livekit.client, false);
  assert((attendeeState.participant.tracks?.length ?? 0) === 0, "Demoted attendee retained a published provider track.");
  await waitForMeetingScreenShare(livekit.client, false);
  await waitForExpression(
    cdp,
    "document.querySelector('.meeting-room')?.innerText.includes('참석자') && !document.querySelector('.meeting-room button[title^=\"마이크\"]') && !document.querySelector('.meeting-room button[title^=\"카메라\"]') && !document.querySelector('.meeting-room .screen-share-stage')",
    "Demoted attendee retained publisher controls or a shared screen in the installed renderer.",
    180
  );
  const demotedMeeting = await apiRequest(runtime, mina.cookie, `/meetings/${meeting.id}`);
  assert(demotedMeeting.participants.find((participant) => participant.isSelf)?.screenShareStatus === "off", "Role demotion did not close the durable screen-share lifecycle.");
  const layout = await evaluate(cdp, `
    (() => {
      const desk = document.querySelector('.meeting-room').getBoundingClientRect();
      const workspace = document.querySelector('.calendar-workspace').getBoundingClientRect();
      const header = document.querySelector('.meeting-room .call-desk-header').getBoundingClientRect();
      const controls = document.querySelector('.meeting-room .call-controls').getBoundingClientRect();
      const tile = document.querySelector('.meeting-room .call-media-tile').getBoundingClientRect();
      return {
        deskVisible: desk.width > 500 && desk.height > 400,
        withinWorkspace: desk.left >= workspace.left && desk.right <= workspace.right + 1,
        noOverlap: header.bottom <= tile.top && tile.bottom <= controls.top,
        controlsVisible: controls.bottom <= innerHeight + 1,
        text: document.querySelector('.meeting-room').innerText
      };
    })()
  `);
  assert(layout.deskVisible && layout.withinWorkspace && layout.noOverlap && layout.controlsVisible, "Installed meeting layout overlaps or is clipped.");
  assert(layout.text.includes("Meeting Renderer Mina") && layout.text.includes("설치본 역할 검증 회의"), "Installed meeting labels are incomplete.");
  await captureScreenshot(cdp, screenshotPath);

  await evaluate(cdp, "document.querySelector('.meeting-room button[title=\"회의 나가기\"]').click()");
  await waitForExpression(cdp, "document.querySelector('.meeting-room[data-phase=\"ended\"]') !== null", "Installed participant leave did not close the media session.");
  const finalMeeting = await apiRequest(runtime, owner.cookie, `/meetings/${meeting.id}`);
  await apiRequest(runtime, owner.cookie, `/meetings/${meeting.id}/end`, { method: "POST", payload: { version: finalMeeting.version } });
  for (let attempt = 0; attempt < 80 && (await livekit.client.listRooms()).length; attempt += 1) await delay(125);
  assert((await livekit.client.listRooms()).length === 0, "Installed meeting provider room remained after host end.");

  await Promise.race([cdp.send("Browser.close").catch(() => undefined), delay(1_000)]);
  for (let attempt = 0; attempt < 80 && isProcessRunning(application.pid); attempt += 1) await delay(125);
  assert(!isProcessRunning(application.pid), "Installed meeting renderer process remained after shutdown.");
  assert(!(await isPortOpen(runtime.databasePort)), "Installed meeting PostgreSQL remained reachable after shutdown.");
  console.log(`Windows installed scheduled meeting passed: lobby, real SFU, speaker screen share, role-based screen/camera/mic revoke, layout, and screenshot ${screenshotPath}`);
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
