const { app, BrowserWindow, Menu, desktopCapturer, dialog, screen, session, shell, utilityProcess } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const developmentWebUrl = process.env.HAHATALK_WEB_URL || "http://127.0.0.1:3000";
const developmentApiUrl = process.env.HAHATALK_API_URL || "http://127.0.0.1:4000";
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
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    "media-src 'self' blob:",
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

async function startPackagedApi(apiEntryPath, webOrigin) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = await findAvailablePort();
    const apiUrl = `http://127.0.0.1:${port}`;
    const apiProcess = utilityProcess.fork(apiEntryPath, [], {
      env: {
        ...process.env,
        HAHATALK_MIGRATIONS_DIR: path.join(path.dirname(apiEntryPath), "migrations"),
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
  const staticRuntime = await startStaticServer(path.join(runtimeRoot, "web"));
  try {
    const apiRuntime = await startPackagedApi(path.join(runtimeRoot, "api.cjs"), staticRuntime.url);
    return {
      apiProcess: apiRuntime.apiProcess,
      apiUrl: apiRuntime.apiUrl,
      staticServer: staticRuntime.server,
      webUrl: staticRuntime.url
    };
  } catch (error) {
    await closeServer(staticRuntime.server);
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

function createWindow() {
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
      createWindow();
    } else {
      openExternalUrl(url);
    }
    return { action: "deny" };
  });

  void win.loadURL(runtime.webUrl).catch((error) => {
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
  for (const window of BrowserWindow.getAllWindows()) {
    window.destroy();
  }
  runtime?.apiProcess?.kill();
  await closeServer(runtime?.staticServer);
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
      if (quitCleanupStarted) return;
      event.preventDefault();
      quitCleanupStarted = true;
      shuttingDown = true;
      void stopRuntime().finally(() => app.quit());
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });

    app.whenReady().then(async () => {
      app.setAppUserModelId(appUserModelId);
      try {
        runtime = await startRuntime();
        configureSessionPermissions();
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
        await stopRuntime();
        app.quit();
      }
    });
  }
}
