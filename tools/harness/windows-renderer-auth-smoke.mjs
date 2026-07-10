import { execFileSync, spawn } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
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

async function waitForRuntime(statusPath, expectedPid) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const status = JSON.parse(await readFile(statusPath, "utf8"));
      if (status.pid === expectedPid && status.rendererReady && status.rendererApiHealthy) {
        return status;
      }
    } catch {
      // Runtime status is created and then enriched by renderer verification.
    }
    await delay(250);
  }
  throw new Error("Installed HahaTalk renderer did not become ready.");
}

async function waitForDebugTarget(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
        if (target) {
          return target;
        }
      }
    } catch {
      // Chromium has not opened the debugging endpoint yet.
    }
    await delay(125);
  }
  throw new Error("Electron CDP target did not become ready.");
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const events = [];
  const pending = new Map();
  let requestId = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) {
      events.push(message);
      return;
    }
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message.result);
    }
  });

  return {
    close: () => socket.close(),
    events,
    send(method, params = {}) {
      requestId += 1;
      const id = requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { reject, resolve });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Renderer evaluation failed.");
  }
  return result.result?.value;
}

async function waitForExpression(cdp, expression, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(cdp, expression)) {
      return;
    }
    await delay(125);
  }
  const bodyText = await evaluate(cdp, "document.body.innerText").catch(() => "renderer text unavailable");
  const runtimeEvents = cdp.events
    .filter((event) => event.method === "Runtime.exceptionThrown" || event.method === "Runtime.consoleAPICalled")
    .slice(-4);
  throw new Error(`${message}\nRenderer text: ${String(bodyText).slice(-1200)}\nRuntime events: ${JSON.stringify(runtimeEvents)}`);
}

async function captureScreenshot(cdp, screenshotPath, message) {
  await cdp.send("Page.bringToFront");
  await evaluate(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await delay(500);
  const capture = await cdp.send("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true
  });
  await writeFile(screenshotPath, Buffer.from(capture.data, "base64"));
  assert((await readFile(screenshotPath)).length > 10_000, message);
}

const desktopPackage = JSON.parse(await readFile(
  path.join(process.cwd(), "apps", "desktop", "package.json"),
  "utf8"
));
const executablePath = path.resolve(argument(
  "executable",
  path.join(process.env.LOCALAPPDATA ?? "", "HahaTalk", `app-${desktopPackage.version}`, "HahaTalk.exe")
));
const screenshotPath = path.resolve(argument(
  "screenshot",
  path.join(process.cwd(), "apps", "desktop", "out", "stage2b-owner-invitation.png")
));
const guestScreenshotPath = path.resolve(argument(
  "guest-screenshot",
  path.join(process.cwd(), "apps", "desktop", "out", "stage2b-guest.png")
));
const password = process.env.HAHATALK_SMOKE_PASSWORD ?? "HahaTalk!Stage2";
const guestEmail = `renderer-guest-${Date.now()}@example.test`;
const guestPassword = "Stage2B!RendererGuest";
const statusPath = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "HahaTalk", "runtime-status.json");
const debugPort = await findAvailablePort();
await access(executablePath);
try {
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "if (Get-Process -Name HahaTalk -ErrorAction SilentlyContinue) { exit 1 }"
  ], { stdio: "ignore" });
} catch {
  throw new Error("A HahaTalk process is already active. Close it before the renderer auth smoke test.");
}
await rm(statusPath, { force: true });

const application = spawn(executablePath, [`--remote-debugging-port=${debugPort}`], {
  detached: false,
  stdio: "ignore",
  windowsHide: false
});
let cdp;
try {
  const runtime = await waitForRuntime(statusPath, application.pid);
  const target = await waitForDebugTarget(debugPort);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const hasAuthenticatedDesk = await evaluate(cdp, `Boolean(document.querySelector('button[title="로그아웃"]'))`);
  if (hasAuthenticatedDesk) {
    await evaluate(cdp, `document.querySelector('button[title="로그아웃"]').click()`);
    await waitForExpression(cdp, `document.body.innerText.includes('HahaTalk 로그인')`, "Existing renderer session did not log out.");
  }

  assert(await evaluate(cdp, `document.querySelector('input[type="password"]') !== null`), "Password field is missing.");
  assert(
    await evaluate(cdp, `localStorage.getItem('hahatalk.authSession.v1') === null`),
    "Renderer still stores an authentication session in localStorage."
  );
  await evaluate(cdp, `
    (() => {
      const loginButton = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '로그인');
      loginButton.click();
    })()
  `);
  await delay(100);
  await evaluate(cdp, `
    (() => {
      const setValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(document.querySelector('input[type="email"]'), 'you@inviz.co.kr');
      setValue(document.querySelector('input[type="password"]'), ${JSON.stringify(password)});
      document.querySelector('form').requestSubmit();
    })()
  `);
  await waitForExpression(
    cdp,
    `document.body.innerText.includes('프로젝트 A 허브방') && Boolean(document.querySelector('button[title="로그아웃"]'))`,
    "Renderer login did not reach the authenticated HahaTalk desk."
  );

  await cdp.send("Page.bringToFront");
  await evaluate(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await delay(500);
  const headerLayout = await evaluate(cdp, `
    (() => {
      const header = document.querySelector('.workspace-header').getBoundingClientRect();
      const actions = document.querySelector('.header-actions').getBoundingClientRect();
      const buttonTops = [...document.querySelectorAll('.header-actions .icon-button')]
        .map((button) => button.getBoundingClientRect().top);
      return {
        actionsInsideHeader: actions.right <= header.right + 1 && actions.bottom <= header.bottom + 1,
        buttonTopSpread: Math.max(...buttonTops) - Math.min(...buttonTops)
      };
    })()
  `);
  assert(headerLayout.actionsInsideHeader, "Header actions overflow the authenticated workspace header.");
  assert(headerLayout.buttonTopSpread <= 1, "Header action buttons wrapped onto multiple rows.");

  await evaluate(cdp, `document.querySelector('button[title="참여자"]').click()`);
  await waitForExpression(cdp, `document.body.innerText.includes('대상 초대')`, "Owner invitation panel did not open.");
  await evaluate(cdp, `
    (() => {
      const input = document.querySelector('.right-panel input[type="email"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(guestEmail)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      [...document.querySelectorAll('.right-panel button')]
        .find((button) => button.textContent.trim() === '초대 생성').click();
    })()
  `);
  await waitForExpression(
    cdp,
    `document.querySelector('.invite-code-box code')?.textContent.startsWith('hti_')`,
    "Owner invitation creation did not return a one-time code."
  );
  const inviteCode = await evaluate(cdp, `document.querySelector('.invite-code-box code').textContent`);
  await captureScreenshot(cdp, screenshotPath, "Owner invitation screenshot is unexpectedly small.");

  await evaluate(cdp, `document.querySelector('button[title="로그아웃"]').click()`);
  await waitForExpression(cdp, `document.body.innerText.includes('HahaTalk 로그인')`, "Renderer logout did not return to login.");
  await evaluate(cdp, `
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '초대 수락').click()
  `);
  await waitForExpression(cdp, `document.body.innerText.includes('HahaTalk 초대 수락')`, "Invitation acceptance screen did not open.");
  await evaluate(cdp, `
    (() => {
      const input = document.querySelector('.auth-panel input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(inviteCode)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.auth-panel form, form.auth-panel').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, `document.body.innerText.includes('Inviz 가입')`, "Invitation preview did not reach guest activation.");
  await evaluate(cdp, `
    (() => {
      const setValue = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const labels = [...document.querySelectorAll('.auth-panel label')];
      setValue(labels.find((label) => label.textContent.includes('이름')).querySelector('input'), 'Renderer Guest');
      setValue(document.querySelector('.auth-panel input[type="password"]'), ${JSON.stringify(guestPassword)});
      document.querySelectorAll('.auth-panel input[type="checkbox"]').forEach((checkbox) => {
        if (!checkbox.checked) checkbox.click();
      });
      document.querySelector('form.auth-panel').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, `document.body.innerText.includes('가입 승인 완료')`, "Guest invitation acceptance did not complete.");
  await evaluate(cdp, `
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '로그인으로 이동').click()
  `);
  await waitForExpression(cdp, `document.body.innerText.includes('HahaTalk 로그인')`, "Accepted guest did not return to login.");
  await evaluate(cdp, `
    (() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const setValue = (input, value) => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(document.querySelector('input[type="email"]'), ${JSON.stringify(guestEmail)});
      setValue(document.querySelector('input[type="password"]'), ${JSON.stringify(guestPassword)});
      document.querySelector('form').requestSubmit();
    })()
  `);
  await waitForExpression(
    cdp,
    `document.body.innerText.includes('게스트 세션') && Boolean(document.querySelector('button[title="로그아웃"]'))`,
    "Accepted guest login did not reach the restricted workspace."
  );
  await evaluate(cdp, `document.querySelector('button[title="참여자"]').click()`);
  await waitForExpression(cdp, `document.body.innerText.includes('내 기기 세션')`, "Guest session panel did not open.");
  assert(
    await evaluate(cdp, `!document.querySelector('.right-panel').innerText.includes('대상 초대')`),
    "Guest renderer exposed invitation management controls."
  );
  assert(
    await evaluate(cdp, `document.body.innerText.includes('1:1 대화')`),
    "Guest renderer exposed the hub as a group conversation."
  );
  assert(
    await evaluate(cdp, `
      [...document.querySelectorAll('.member-row')]
        .find((row) => row.innerText.includes('Renderer Guest'))?.innerText.includes('게스트')
    `),
    "Dynamic guest membership was not labeled as guest."
  );
  await captureScreenshot(cdp, guestScreenshotPath, "Guest restriction screenshot is unexpectedly small.");

  await evaluate(cdp, `document.querySelector('button[title="로그아웃"]').click()`);
  await waitForExpression(cdp, `document.body.innerText.includes('HahaTalk 로그인')`, "Guest renderer logout did not return to login.");
  await Promise.race([
    cdp.send("Browser.close").catch(() => undefined),
    delay(500)
  ]);

  let statusRemoved = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await access(statusPath);
    } catch {
      statusRemoved = true;
      break;
    }
    await delay(250);
  }
  for (let attempt = 0; attempt < 60 && isProcessRunning(application.pid); attempt += 1) {
    await delay(250);
  }
  assert(statusRemoved, "HahaTalk runtime status remained after renderer smoke shutdown.");
  assert(!isProcessRunning(application.pid), "HahaTalk process remained after renderer smoke shutdown.");
  console.log(`Windows renderer invitation check passed: ${runtime.version}, owner ${screenshotPath}, guest ${guestScreenshotPath}`);
} finally {
  cdp?.close();
  if (isProcessRunning(application.pid)) {
    application.kill();
  }
}
