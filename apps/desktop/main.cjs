const { app, BrowserWindow, Menu, desktopCapturer, dialog, ipcMain, screen, session, shell, utilityProcess } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const userDataOverride = process.env.HAHATALK_USER_DATA_DIR?.trim();
if (userDataOverride) {
  const resolvedUserData = path.resolve(userDataOverride);
  fs.mkdirSync(resolvedUserData, { recursive: true });
  app.setPath("userData", resolvedUserData);
}

const developmentWebUrl = process.env.HAHATALK_WEB_URL || "http://127.0.0.1:3000";
const developmentApiUrl = process.env.HAHATALK_API_URL || "http://127.0.0.1:4000";

if (process.env.HAHATALK_TEST_FAKE_MEDIA === "1") {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}
const appUserModelId = "com.squirrel.HahaTalk.HahaTalk";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

let runtime = null;
let runtimeReady = false;
let runtimeStatus = null;
let shuttingDown = false;
let quitCleanupStarted = false;
let quitCleanupComplete = false;
let remoteSupportAgent = null;
let remoteSupportAgentStatus = { state: "stopped" };

function runSquirrelCommand(args) {
  const updateExecutable = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  spawn(updateExecutable, args, { detached: true }).once("close", () => app.quit());
}

function handleSquirrelStartup() {
  if (process.platform !== "win32") return false;

  const command = process.argv[1];
  const executableName = path.basename(process.execPath);
  if (command === "--squirrel-install" || command === "--squirrel-updated") {
    runSquirrelCommand([`--createShortcut=${executableName}`]);
    return true;
  }
  if (command === "--squirrel-uninstall") {
    runSquirrelCommand([`--removeShortcut=${executableName}`]);
    return true;
  }
  if (command === "--squirrel-obsolete") {
    app.quit();
    return true;
  }
  return false;
}

const squirrelStartup = handleSquirrelStartup();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendRuntimeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(app.getPath("logs"), { recursive: true });
    fs.appendFileSync(path.join(app.getPath("logs"), "hahatalk-runtime.log"), line, "utf8");
  } catch {
    // Logging must never block startup or shutdown.
  }
}

function getRuntimeStatusPath() {
  return path.join(app.getPath("userData"), "runtime-status.json");
}

function writeRuntimeStatus(nextRuntime, extra = {}) {
  runtimeStatus = {
    pid: process.pid,
    version: app.getVersion(),
    packaged: app.isPackaged,
    webUrl: nextRuntime.webUrl,
    apiUrl: nextRuntime.apiUrl,
    databaseMode: nextRuntime.databaseRuntime?.managed ? "embedded-postgresql" : "external",
    databasePort: nextRuntime.databaseRuntime?.port ?? null,
    readyAt: runtimeStatus?.readyAt || new Date().toISOString(),
    ...runtimeStatus,
    ...extra
  };

  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(getRuntimeStatusPath(), `${JSON.stringify(runtimeStatus, null, 2)}\n`, "utf8");
}

function removeRuntimeStatus() {
  try {
    fs.rmSync(getRuntimeStatusPath(), { force: true });
  } catch {
    // A stale status file is harmless and will be replaced on next start.
  }
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Local runtime did not provide a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server?.listening) {
      resolve();
      return;
    }
    let completed = false;
    const timeout = setTimeout(() => finish(), 1_000);
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      resolve();
    };
    try {
      server.close(finish);
      server.closeAllConnections?.();
    } catch {
      finish();
    }
  });
}

async function findAvailablePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

function setStaticHeaders(response) {
  const connectSources = ["'self'", "http://127.0.0.1:*", "ws://127.0.0.1:*"];
  try {
    const livekitUrl = new URL(process.env.LIVEKIT_URL || "");
    if (["https:", "wss:"].includes(livekitUrl.protocol)) {
      livekitUrl.protocol = "wss:";
      connectSources.push(livekitUrl.origin);
    }
  } catch {
    // An invalid provider URL is rejected by the API capability boundary.
  }
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http://127.0.0.1:*",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "media-src 'self' blob: http://127.0.0.1:*",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; "));
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

async function resolveStaticFile(webRoot, requestUrl) {
  const root = path.resolve(webRoot);
  const pathname = decodeURIComponent(new URL(requestUrl || "/", "http://127.0.0.1").pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let candidate = path.resolve(root, relativePath);

  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  let stats = await fsp.stat(candidate).catch(() => null);
  if (stats?.isDirectory()) {
    candidate = path.join(candidate, "index.html");
    stats = await fsp.stat(candidate).catch(() => null);
  }

  if (!stats?.isFile()) {
    const notFound = path.join(root, "404.html");
    const notFoundStats = await fsp.stat(notFound).catch(() => null);
    return notFoundStats?.isFile() ? notFound : null;
  }

  return candidate;
}

async function startStaticServer(webRoot) {
  const indexPath = path.join(webRoot, "index.html");
  await fsp.access(indexPath);

  const server = http.createServer(async (request, response) => {
    setStaticHeaders(response);
    try {
      const filePath = await resolveStaticFile(webRoot, request.url);
      if (!filePath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const cacheControl = filePath.includes(`${path.sep}_next${path.sep}static${path.sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      response.writeHead(filePath.endsWith("404.html") ? 404 : 200, {
        "Cache-Control": cacheControl,
        "Content-Type": mimeTypes[extension] || "application/octet-stream"
      });

      if (request.method === "HEAD") {
        response.end();
        return;
      }
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      appendRuntimeLog(`Static server error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("HahaTalk desktop runtime error");
    }
  });

  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

async function waitForHealth(url, attempts = 80) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
      lastError = new Error(`Health check returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(125);
  }
  throw lastError instanceof Error ? lastError : new Error("API health check timed out.");
}

function runExecutable(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = { code: code ?? -1, output: output.join("") };
      if (!(options.acceptedExitCodes ?? [0]).includes(result.code)) {
        reject(new Error(`${path.basename(executable)} failed with code ${result.code}: ${result.output.trim()}`));
        return;
      }
      resolve(result);
    });
  });
}

async function readOrCreateDatabaseCredentials(dataDirectory) {
  const credentialsPath = path.join(app.getPath("userData"), "postgres-credentials.json");
  const initialized = fs.existsSync(path.join(dataDirectory, "PG_VERSION"));
  try {
    const credentials = JSON.parse(await fsp.readFile(credentialsPath, "utf8"));
    if (credentials.user === "hahatalk" && typeof credentials.password === "string" && credentials.password.length >= 32) {
      return credentials;
    }
  } catch {
    if (initialized) {
      throw new Error("Embedded PostgreSQL credentials are missing for an existing data directory.");
    }
  }

  const credentials = { user: "hahatalk", password: randomBytes(32).toString("base64url") };
  await fsp.mkdir(path.dirname(credentialsPath), { recursive: true });
  await fsp.writeFile(credentialsPath, `${JSON.stringify(credentials)}\n`, { encoding: "utf8", mode: 0o600 });
  return credentials;
}

async function startEmbeddedPostgres(runtimeRoot) {
  const explicitDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (explicitDatabaseUrl) {
    return { databaseUrl: explicitDatabaseUrl, managed: false };
  }

  const postgresRoot = path.join(runtimeRoot, "postgres");
  const binaryDirectory = path.join(postgresRoot, "bin");
  const pgCtl = path.join(binaryDirectory, "pg_ctl.exe");
  const initdb = path.join(binaryDirectory, "initdb.exe");
  const psql = path.join(binaryDirectory, "psql.exe");
  const createdb = path.join(binaryDirectory, "createdb.exe");
  for (const executable of [pgCtl, initdb, psql, createdb]) {
    await fsp.access(executable);
  }

  const dataDirectory = path.join(app.getPath("userData"), "postgres-data");
  const logDirectory = app.getPath("logs");
  const logPath = path.join(logDirectory, "postgresql.log");
  await fsp.mkdir(dataDirectory, { recursive: true });
  await fsp.mkdir(logDirectory, { recursive: true });
  const credentials = await readOrCreateDatabaseCredentials(dataDirectory);
  const initialized = fs.existsSync(path.join(dataDirectory, "PG_VERSION"));

  if (!initialized) {
    const passwordPath = path.join(app.getPath("temp"), `hahatalk-postgres-${process.pid}.pw`);
    await fsp.writeFile(passwordPath, credentials.password, { encoding: "ascii", mode: 0o600 });
    try {
      await runExecutable(initdb, [
        "-D", dataDirectory,
        "-U", credentials.user,
        `--pwfile=${passwordPath}`,
        "--auth-host=scram-sha-256",
        "--auth-local=scram-sha-256",
        "-E", "UTF8",
        "--locale=C"
      ]);
    } finally {
      await fsp.rm(passwordPath, { force: true });
    }
  }

  const status = await runExecutable(pgCtl, ["-D", dataDirectory, "status"], { acceptedExitCodes: [0, 3] });
  let port;
  if (status.code === 0) {
    const pidLines = (await fsp.readFile(path.join(dataDirectory, "postmaster.pid"), "utf8")).split(/\r?\n/);
    port = Number(pidLines[3]);
    if (!Number.isInteger(port) || port < 1) {
      throw new Error("Embedded PostgreSQL reported an invalid port.");
    }
  } else {
    port = await findAvailablePort();
    await runExecutable(pgCtl, [
      "-D", dataDirectory,
      "-l", logPath,
      "-o", `-p ${port} -h 127.0.0.1`,
      "-w", "start"
    ]);
  }

  const databaseEnv = { PGPASSWORD: credentials.password };
  const exists = await runExecutable(psql, [
    "-h", "127.0.0.1",
    "-p", String(port),
    "-U", credentials.user,
    "-d", "postgres",
    "-tAc", "select 1 from pg_database where datname = 'hahatalk'"
  ], { env: databaseEnv });
  if (exists.output.trim() !== "1") {
    await runExecutable(createdb, [
      "-h", "127.0.0.1",
      "-p", String(port),
      "-U", credentials.user,
      "hahatalk"
    ], { env: databaseEnv });
  }

  const databaseUrl = `postgresql://${credentials.user}:${encodeURIComponent(credentials.password)}@127.0.0.1:${port}/hahatalk`;
  appendRuntimeLog(`Embedded PostgreSQL is ready on 127.0.0.1:${port}.`);
  return { databaseUrl, dataDirectory, managed: true, pgCtl, port };
}

async function stopEmbeddedPostgres(databaseRuntime) {
  if (!databaseRuntime?.managed) return;
  try {
    await runExecutable(
      databaseRuntime.pgCtl,
      ["-D", databaseRuntime.dataDirectory, "-m", "fast", "-w", "stop"],
      { acceptedExitCodes: [0, 3] }
    );
    appendRuntimeLog("Embedded PostgreSQL stopped cleanly.");
  } catch (error) {
    appendRuntimeLog(`Embedded PostgreSQL shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pipeApiLogs(apiProcess) {
  apiProcess.stdout?.on("data", (chunk) => appendRuntimeLog(`[api] ${String(chunk).trimEnd()}`));
  apiProcess.stderr?.on("data", (chunk) => appendRuntimeLog(`[api:error] ${String(chunk).trimEnd()}`));
  apiProcess.on("exit", (code) => {
    appendRuntimeLog(`API utility process exited with code ${code}.`);
    if (runtimeReady && !shuttingDown) {
      dialog.showErrorBox("HahaTalk 서비스 중단", "내부 API가 종료되어 HahaTalk을 안전하게 닫습니다. 다시 실행해 주세요.");
      app.quit();
    }
  });
}

async function startPackagedApi(apiEntryPath, webOrigin, databaseUrl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = await findAvailablePort();
    const apiUrl = `http://127.0.0.1:${port}`;
    const apiProcess = utilityProcess.fork(apiEntryPath, [], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        HAHATALK_MIGRATIONS_DIR: path.join(path.dirname(apiEntryPath), "migrations"),
        HAHATALK_OBJECT_ROOT: path.join(app.getPath("userData"), "objects"),
        NODE_ENV: "production",
        PORT: String(port),
        SESSION_COOKIE_NAME: "hahatalk_desktop_session",
        WEB_ORIGIN: webOrigin
      },
      serviceName: "HahaTalk API",
      stdio: "pipe"
    });
    pipeApiLogs(apiProcess);

    try {
      await waitForHealth(`${apiUrl}/health`);
      return { apiProcess, apiUrl };
    } catch (error) {
      lastError = error;
      appendRuntimeLog(`API start attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      apiProcess.kill();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("HahaTalk API failed to start.");
}

async function startRuntime() {
  removeRuntimeStatus();
  if (!app.isPackaged) {
    return {
      apiProcess: null,
      apiUrl: developmentApiUrl,
      staticServer: null,
      webUrl: developmentWebUrl
    };
  }

  const runtimeRoot = path.join(process.resourcesPath, "runtime");
  const databaseRuntime = await startEmbeddedPostgres(runtimeRoot);
  const staticRuntime = await startStaticServer(path.join(runtimeRoot, "web"));
  try {
    const apiRuntime = await startPackagedApi(path.join(runtimeRoot, "api.cjs"), staticRuntime.url, databaseRuntime.databaseUrl);
    return {
      apiProcess: apiRuntime.apiProcess,
      apiUrl: apiRuntime.apiUrl,
      databaseRuntime,
      staticServer: staticRuntime.server,
      webUrl: staticRuntime.url
    };
  } catch (error) {
    await closeServer(staticRuntime.server);
    await stopEmbeddedPostgres(databaseRuntime);
    throw error;
  }
}

function isAllowedInternalUrl(value) {
  if (!runtime?.webUrl) {
    return false;
  }
  try {
    return new URL(value).origin === new URL(runtime.webUrl).origin;
  } catch {
    return false;
  }
}

function openExternalUrl(value) {
  try {
    const parsed = new URL(value);
    if (["https:", "http:", "mailto:"].includes(parsed.protocol)) {
      void shell.openExternal(parsed.toString());
    }
  } catch {
    // Ignore malformed navigation requests.
  }
}

function isTrustedRenderer(event) {
  const senderUrl = event.senderFrame?.url || event.sender?.getURL();
  return Boolean(senderUrl && isAllowedInternalUrl(senderUrl));
}

function broadcastRemoteSupportStatus(status) {
  remoteSupportAgentStatus = { ...remoteSupportAgentStatus, ...status, updatedAt: new Date().toISOString() };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("remote-support:agent-status", remoteSupportAgentStatus);
  }
}

function remoteSupportDeviceId() {
  const devicePath = path.join(app.getPath("userData"), "remote-support-device.json");
  try {
    const existing = JSON.parse(fs.readFileSync(devicePath, "utf8"));
    if (typeof existing.deviceId === "string" && /^hht_device_[A-Za-z0-9_-]{24,80}$/.test(existing.deviceId)) {
      return existing.deviceId;
    }
  } catch {
    // Create an opaque installation identifier below.
  }
  const deviceId = `hht_device_${randomBytes(24).toString("base64url")}`;
  fs.mkdirSync(path.dirname(devicePath), { recursive: true });
  fs.writeFileSync(devicePath, `${JSON.stringify({ deviceId })}\n`, { encoding: "utf8", mode: 0o600 });
  return deviceId;
}

function stopRemoteSupportAgent(reason = "user_stopped") {
  const agent = remoteSupportAgent;
  remoteSupportAgent = null;
  if (agent) {
    try {
      agent.postMessage({ type: "stop" });
      setTimeout(() => agent.kill(), 500).unref();
    } catch {
      agent.kill();
    }
  }
  broadcastRemoteSupportStatus({ reason, state: "stopped" });
  return remoteSupportAgentStatus;
}

function configureRemoteSupportIpc() {
  ipcMain.handle("remote-support:agent-status", (event) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted remote support status request.");
    return remoteSupportAgentStatus;
  });
  ipcMain.handle("remote-support:stop-agent", (event) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted remote support stop request.");
    return stopRemoteSupportAgent();
  });
  ipcMain.handle("remote-support:start-agent", (event, payload) => {
    if (!isTrustedRenderer(event)) throw new Error("Untrusted remote support activation request.");
    if (
      !payload
      || typeof payload.activationSecret !== "string"
      || !/^[A-Za-z0-9_-]{40,200}$/.test(payload.activationSecret)
      || typeof payload.sessionId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sessionId)
    ) {
      throw new Error("Invalid remote support activation payload.");
    }
    stopRemoteSupportAgent("replaced");
    const agentInstanceId = `hht_agent_${randomBytes(24).toString("base64url")}`;
    const child = utilityProcess.fork(path.join(__dirname, "remote-support-agent.cjs"), [], {
      env: { NODE_ENV: app.isPackaged ? "production" : "development" },
      serviceName: "HahaTalk Remote Support Agent",
      stdio: "pipe"
    });
    remoteSupportAgent = child;
    child.stdout?.on("data", (chunk) => appendRuntimeLog(`[remote-agent] ${String(chunk).trimEnd()}`));
    child.stderr?.on("data", (chunk) => appendRuntimeLog(`[remote-agent:error] ${String(chunk).trimEnd()}`));
    child.on("message", (message) => {
      if (message?.type !== "remote-support-status") return;
      const { commandKind, controlEpoch, detail, outcome, sequence, state } = message;
      broadcastRemoteSupportStatus({ commandKind, controlEpoch, detail, outcome, sequence, sessionId: payload.sessionId, state });
    });
    child.on("exit", (code) => {
      if (remoteSupportAgent === child) remoteSupportAgent = null;
      broadcastRemoteSupportStatus({ exitCode: code, sessionId: payload.sessionId, state: "stopped" });
    });
    remoteSupportAgentStatus = { state: "starting" };
    broadcastRemoteSupportStatus({ mode: "dry_run", sessionId: payload.sessionId, state: "starting" });
    child.postMessage({
      type: "activate",
      configuration: {
        activationSecret: payload.activationSecret,
        agentInstanceId,
        agentVersion: app.getVersion(),
        apiBaseUrl: runtime.apiUrl,
        deviceId: remoteSupportDeviceId(),
        platform: process.platform,
        sessionId: payload.sessionId
      }
    });
    payload.activationSecret = undefined;
    return remoteSupportAgentStatus;
  });
}

function createWindow(initialUrl = runtime.webUrl) {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, workArea.width);
  const height = Math.min(920, workArea.height);
  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(1040, width),
    minHeight: Math.min(640, height),
    show: false,
    title: "HahaTalk",
    backgroundColor: "#f6f7f4",
    webPreferences: {
      additionalArguments: [
        `--hahatalk-api-url=${runtime.apiUrl}`,
        `--hahatalk-version=${app.getVersion()}`,
        `--hahatalk-packaged=${app.isPackaged ? "1" : "0"}`
      ],
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true
    }
  });

  win.once("ready-to-show", () => win.show());
  win.webContents.once("did-finish-load", () => {
    void win.webContents.executeJavaScript(`
      (async () => {
        const bridge = window.hahaTalkDesktop;
        const response = await fetch(bridge.apiBaseUrl + "/health");
        return { apiBaseUrl: bridge.apiBaseUrl, apiHealthy: response.ok, title: document.title };
      })()
    `).then((rendererCheck) => {
      if (!rendererCheck.apiHealthy || rendererCheck.apiBaseUrl !== runtime.apiUrl || rendererCheck.title !== "HahaTalk") {
        throw new Error("Renderer runtime bridge verification failed.");
      }
      writeRuntimeStatus(runtime, {
        rendererApiHealthy: true,
        rendererReady: true,
        rendererVerifiedAt: new Date().toISOString()
      });
    }).catch((error) => {
      appendRuntimeLog(`Renderer runtime verification failed: ${error instanceof Error ? error.message : String(error)}`);
      dialog.showErrorBox("HahaTalk 연결 오류", "화면과 내부 서비스 연결을 확인하지 못했습니다. 앱을 다시 실행해 주세요.");
      app.quit();
    });
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedInternalUrl(url)) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedInternalUrl(url) || url === "about:blank") {
      createWindow(isAllowedInternalUrl(url) ? url : runtime.webUrl);
    } else {
      openExternalUrl(url);
    }
    return { action: "deny" };
  });

  void win.loadURL(initialUrl).catch((error) => {
    appendRuntimeLog(`Renderer load failed: ${error instanceof Error ? error.message : String(error)}`);
    dialog.showErrorBox("HahaTalk 화면 오류", "화면을 불러오지 못했습니다. 앱을 다시 실행해 주세요.");
  });
  return win;
}

function buildApplicationMenu() {
  const viewItems = [
    { role: "reload", label: "새로고침" },
    { type: "separator" },
    { role: "resetZoom", label: "기본 확대" },
    { role: "zoomIn", label: "확대" },
    { role: "zoomOut", label: "축소" },
    { role: "togglefullscreen", label: "전체 화면" }
  ];

  if (!app.isPackaged) {
    viewItems.splice(1, 0, { role: "toggleDevTools", label: "개발자 도구" });
  }

  return Menu.buildFromTemplate([
    {
      label: "HahaTalk",
      submenu: [
        { label: "새 채팅 창", accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        { role: "quit", label: "종료" }
      ]
    },
    { label: "보기", submenu: viewItems }
  ]);
}

function isRuntimeOrigin(value) {
  try {
    const origin = new URL(value).origin;
    return Boolean(runtime && [runtime.webUrl, runtime.apiUrl].some((url) => new URL(url).origin === origin));
  } catch {
    return false;
  }
}

function configureSessionPermissions() {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return isRuntimeOrigin(requestingOrigin) && ["display-capture", "fullscreen", "media"].includes(permission);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || webContents.getURL();
    callback(isRuntimeOrigin(requestingUrl) && ["display-capture", "fullscreen", "media"].includes(permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.userGesture || !isRuntimeOrigin(request.securityOrigin)) {
      callback({});
      return;
    }

    try {
      const sources = await desktopCapturer.getSources({
        fetchWindowIcons: true,
        thumbnailSize: { width: 0, height: 0 },
        types: ["screen", "window"]
      });
      const selectableSources = sources.slice(0, 12);
      if (process.env.HAHATALK_TEST_FAKE_MEDIA === "1") {
        const source = selectableSources.find((candidate) => candidate.id.startsWith("screen:")) ?? selectableSources[0];
        callback(source ? { video: source } : {});
        return;
      }
      const cancelIndex = selectableSources.length;
      const result = await dialog.showMessageBox({
        buttons: [...selectableSources.map((source) => source.name), "취소"],
        cancelId: cancelIndex,
        defaultId: 0,
        detail: "공유할 화면이나 창을 직접 선택하세요. 선택 전에는 어떤 화면도 전송되지 않습니다.",
        message: "공유할 화면 선택",
        noLink: true,
        title: "HahaTalk 화면 캡처",
        type: "question"
      });
      callback(result.response < selectableSources.length ? { video: selectableSources[result.response] } : {});
    } catch (error) {
      appendRuntimeLog(`Display media selection failed: ${error instanceof Error ? error.message : String(error)}`);
      callback({});
    }
  });
}

async function stopRuntime() {
  runtimeReady = false;
  runtimeStatus = null;
  removeRuntimeStatus();
  stopRemoteSupportAgent("app_shutdown");
  for (const window of BrowserWindow.getAllWindows()) {
    window.destroy();
  }
  runtime?.apiProcess?.kill();
  await delay(250);
  await closeServer(runtime?.staticServer);
  await stopEmbeddedPostgres(runtime?.databaseRuntime);
  runtime = null;
}

if (squirrelStartup) {
  app.quit();
} else {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        const win = windows[0];
        if (win.isMinimized()) win.restore();
        win.focus();
      } else if (runtimeReady) {
        createWindow();
      }
    });

    app.on("before-quit", (event) => {
      if (quitCleanupComplete) return;
      event.preventDefault();
      if (quitCleanupStarted) return;
      quitCleanupStarted = true;
      shuttingDown = true;
      void stopRuntime().finally(() => {
        quitCleanupComplete = true;
        app.quit();
      });
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin" && !quitCleanupStarted) app.quit();
    });

    app.whenReady().then(async () => {
      app.setAppUserModelId(appUserModelId);
      try {
        runtime = await startRuntime();
        configureSessionPermissions();
        configureRemoteSupportIpc();
        Menu.setApplicationMenu(buildApplicationMenu());
        writeRuntimeStatus(runtime);
        runtimeReady = true;
        createWindow();

        app.on("activate", () => {
          if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        appendRuntimeLog(`Desktop startup failed: ${message}`);
        dialog.showErrorBox("HahaTalk 시작 실패", "내부 서비스를 시작하지 못했습니다. 로그를 확인한 뒤 다시 실행해 주세요.");
        shuttingDown = true;
        quitCleanupStarted = true;
        await stopRuntime();
        quitCleanupComplete = true;
        app.quit();
      }
    });
  }
}
