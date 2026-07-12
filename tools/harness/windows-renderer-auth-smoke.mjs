import { execFileSync, spawn } from "node:child_process";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function isPortOpen(port) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(false);
      return;
    }
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(700, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
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

async function waitForAdditionalTarget(port, originalTargetId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((candidate) => (
          candidate.type === "page" && candidate.id !== originalTargetId && candidate.webSocketDebuggerUrl
        ));
        if (target) return target;
      }
    } catch {
      // The additional Electron window is still opening.
    }
    await delay(125);
  }
  throw new Error("Electron media pop-out target did not become ready.");
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
    throw new Error(
      result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? "Renderer evaluation failed."
    );
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
  const mediaState = await evaluate(cdp, `
    (() => {
      const image = document.querySelector('.file-preview img');
      return image ? { complete: image.complete, crossOrigin: image.crossOrigin, currentSrc: image.currentSrc, naturalHeight: image.naturalHeight, naturalWidth: image.naturalWidth, src: image.src } : null;
    })()
  `).catch(() => null);
  const networkEvents = cdp.events
    .filter((event) => event.method === "Network.responseReceived" || event.method === "Network.loadingFailed")
    .slice(-8)
    .map((event) => ({
      errorText: event.params?.errorText,
      method: event.method,
      status: event.params?.response?.status,
      url: event.params?.response?.url
    }));
  throw new Error(`${message}\nRenderer text: ${String(bodyText).slice(-1200)}\nMedia state: ${JSON.stringify(mediaState)}\nRuntime events: ${JSON.stringify(runtimeEvents)}\nNetwork events: ${JSON.stringify(networkEvents)}`);
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

async function loginRenderer(cdp, email, password, message) {
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
  await waitForExpression(cdp, `Boolean(document.querySelector('button[title="로그아웃"]'))`, message);
}

async function logoutRenderer(cdp, message) {
  await evaluate(cdp, `document.querySelector('button[title="로그아웃"]').click()`);
  await waitForExpression(cdp, `document.body.innerText.includes('HahaTalk 로그인')`, message);
}

async function openContacts(cdp, message) {
  await evaluate(cdp, `document.querySelector('button[title="사람"]').click()`);
  await waitForExpression(cdp, `Boolean(document.querySelector('.contacts-sidebar')) && document.body.innerText.includes('연락처 그룹')`, message);
  await waitForExpression(
    cdp,
    `!document.querySelector('.contacts-loading[aria-busy="true"]')`,
    `${message} Contacts data did not finish loading.`
  );
}

function createMinimalPdf(label) {
  const stream = `BT /F1 18 Tf 72 720 Td (${label.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

async function injectRendererFile(cdp, fileName, mimeType, content) {
  const base64 = content.toString("base64");
  await evaluate(cdp, `
    (() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (character) => character.charCodeAt(0));
      const file = new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.querySelector('input[type="file"]');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
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
  path.join(process.cwd(), "apps", "desktop", "out", "stage3-owner-conversation.png")
));
const guestScreenshotPath = path.resolve(argument(
  "guest-screenshot",
  path.join(process.cwd(), "apps", "desktop", "out", "stage3-guest.png")
));
const contactsOwnerScreenshotPath = path.resolve(argument(
  "contacts-owner-screenshot",
  path.join(process.cwd(), "apps", "desktop", "out", "stage4-owner-contacts.png")
));
const contactsMemberScreenshotPath = path.resolve(argument(
  "contacts-member-screenshot",
  path.join(process.cwd(), "apps", "desktop", "out", "stage4-member-contacts.png")
));
const mediaScreenshotPath = path.resolve(argument(
  "media-screenshot",
  path.join(process.cwd(), "apps", "desktop", "out", "stage5-media-document-desk.png")
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
let runtime;
try {
  runtime = await waitForRuntime(statusPath, application.pid);
  const target = await waitForDebugTarget(debugPort);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

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

  assert(
    await evaluate(cdp, `document.querySelectorAll('.room-item').length === 3`),
    "Persisted conversation list did not render all seeded spaces."
  );
  await evaluate(cdp, `
    [...document.querySelectorAll('.room-item')]
      .find((button) => button.innerText.includes('인비즈 업무 단체방')).click()
  `);
  await waitForExpression(cdp, `document.querySelector('.room-title')?.textContent.includes('인비즈 업무 단체방')`, "Persisted group room did not open.");
  await waitForExpression(cdp, `document.body.innerText.includes('실시간')`, "Socket.IO realtime state did not become online.");

  const messageMarker = `Stage 3 renderer ${Date.now()}`;
  const editedMarker = `${messageMarker} edited`;
  const replyMarker = `${messageMarker} reply`;
  const deleteMarker = `${messageMarker} delete`;
  const setComposer = (value) => evaluate(cdp, `
    (() => {
      const textarea = document.querySelector('.composer-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(value)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await setComposer(messageMarker);
  await evaluate(cdp, `document.querySelector('button[title="보내기"]').click()`);
  await waitForExpression(
    cdp,
    `[...document.querySelectorAll('.message')].some((row) => row.innerText.includes(${JSON.stringify(messageMarker)}))`,
    "Renderer did not display the persisted message."
  );

  await evaluate(cdp, `
    [...document.querySelectorAll('.message')]
      .find((row) => row.innerText.includes(${JSON.stringify(messageMarker)}))
      .querySelector('button[title="수정"]').click()
  `);
  await setComposer(editedMarker);
  await evaluate(cdp, `document.querySelector('button[title="수정 저장"]').click()`);
  await waitForExpression(
    cdp,
    `[...document.querySelectorAll('.message')].some((row) => row.innerText.includes(${JSON.stringify(editedMarker)}) && row.innerText.includes('수정됨'))`,
    "Renderer message edit did not persist."
  );

  await evaluate(cdp, `
    [...document.querySelectorAll('.message')]
      .find((row) => row.innerText.includes(${JSON.stringify(editedMarker)}))
      .querySelector('button[title="답장"]').click()
  `);
  await setComposer(replyMarker);
  await evaluate(cdp, `document.querySelector('button[title="보내기"]').click()`);
  await waitForExpression(
    cdp,
    `[...document.querySelectorAll('.message')].some((row) => row.innerText.includes(${JSON.stringify(replyMarker)}) && row.querySelector('.reply-reference'))`,
    "Renderer reply relationship did not render."
  );

  await evaluate(cdp, `
    (() => {
      const input = document.querySelector('.search-box input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(editedMarker)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.search-box').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, `document.querySelector('.search-result')?.innerText.includes(${JSON.stringify(editedMarker)})`, "Renderer delivery-scoped search failed.");

  await setComposer(deleteMarker);
  await evaluate(cdp, `document.querySelector('button[title="보내기"]').click()`);
  await waitForExpression(
    cdp,
    `[...document.querySelectorAll('.message')].some((row) => row.innerText.includes(${JSON.stringify(deleteMarker)}))`,
    "Renderer delete fixture message was not stored."
  );
  await evaluate(cdp, `
    [...document.querySelectorAll('.message')]
      .find((row) => row.innerText.includes(${JSON.stringify(deleteMarker)}))
      .querySelector('button[title="삭제"]').click()
  `);
  await waitForExpression(
    cdp,
    `![...document.querySelectorAll('.message')].some((row) => row.innerText.includes(${JSON.stringify(deleteMarker)}))`,
    "Renderer message delete did not remove the message."
  );

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

  const contactGroupMarker = `Renderer family ${Date.now()}`;
  const contactPrivateMarker = `Owner-only note ${Date.now()}`;
  await logoutRenderer(cdp, "Guest did not return to login before the contacts check.");
  await loginRenderer(cdp, "you@inviz.co.kr", password, "Owner could not log back in for the contacts check.");
  await openContacts(cdp, "Owner contacts desk did not open.");
  await waitForExpression(cdp, `Boolean(document.querySelector('form.contacts-create'))`, "Owner contacts creation form did not become available.");
  await evaluate(cdp, `
    (() => {
      const setInput = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const form = document.querySelector('form.contacts-create');
      setInput(form.querySelector('input[placeholder="새 그룹 이름"]'), ${JSON.stringify(contactGroupMarker)});
      setInput(form.querySelector('input[placeholder="설명"]'), 'Renderer consented family');
      form.requestSubmit();
    })()
  `);
  await waitForExpression(
    cdp,
    `[...document.querySelectorAll('.collection-item')].some((item) => item.innerText.includes(${JSON.stringify(contactGroupMarker)}))`,
    "Owner could not create a family collection in the installed renderer."
  );
  await evaluate(cdp, `
    (() => {
      const section = [...document.querySelectorAll('.contacts-control-section')]
        .find((candidate) => candidate.innerText.includes('구성원 추가'));
      const select = section.querySelector('select');
      const option = [...select.options].find((candidate) => candidate.textContent.includes(${JSON.stringify(guestEmail)}));
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      [...section.querySelectorAll('button')].find((button) => button.textContent.trim() === '추가').click();
    })()
  `);
  await waitForExpression(
    cdp,
    `[...document.querySelectorAll('.contact-member-item')].some((item) => item.innerText.includes('Renderer Guest'))`,
    "Owner could not add the invited guest to the family collection."
  );
  await evaluate(cdp, `
    [...document.querySelectorAll('.contact-member-item')]
      .find((item) => item.innerText.includes('Renderer Guest')).click()
  `);
  await waitForExpression(cdp, `Boolean(document.querySelector('.member-editor'))`, "Private member editor did not open.");
  await evaluate(cdp, `
    (() => {
      const editor = document.querySelector('.member-editor');
      const inputs = [...editor.querySelectorAll('input')].filter((input) => input.type === 'text');
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      inputSetter.call(inputs[0], 'renderer family');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      textSetter.call(editor.querySelector('.member-notes'), ${JSON.stringify(contactPrivateMarker)});
      editor.querySelector('.member-notes').dispatchEvent(new Event('input', { bubbles: true }));
      [...editor.querySelectorAll('button')].find((button) => button.textContent.trim() === '저장').click();
    })()
  `);
  await waitForExpression(cdp, `document.body.innerText.includes('관계 정보를 저장했습니다.')`, "Owner-private relationship details did not save.");
  await captureScreenshot(cdp, contactsOwnerScreenshotPath, "Owner contacts screenshot is unexpectedly small.");

  await logoutRenderer(cdp, "Owner did not return to login for the owner-only privacy check.");
  await loginRenderer(cdp, guestEmail, guestPassword, "Guest could not log in for the owner-only privacy check.");
  await openContacts(cdp, "Guest contacts desk did not open for the owner-only privacy check.");
  assert(
    await evaluate(cdp, `!document.body.innerText.includes(${JSON.stringify(contactGroupMarker)})`),
    "Owner-only family collection leaked to its guest member."
  );
  assert(
    await evaluate(cdp, `!document.body.innerText.includes(${JSON.stringify(contactPrivateMarker)})`),
    "Owner-private relationship notes leaked to the guest member."
  );

  await logoutRenderer(cdp, "Guest did not return to login before the sharing policy check.");
  await loginRenderer(cdp, "you@inviz.co.kr", password, "Owner could not log in to share the family collection.");
  await openContacts(cdp, "Owner contacts desk did not reopen for sharing.");
  await evaluate(cdp, `
    [...document.querySelectorAll('.collection-item')]
      .find((item) => item.innerText.includes(${JSON.stringify(contactGroupMarker)})).click()
  `);
  await waitForExpression(cdp, `document.querySelector('.room-title')?.textContent.includes(${JSON.stringify(contactGroupMarker)})`, "Owner family collection did not reopen.");
  await evaluate(cdp, `
    (() => {
      const section = [...document.querySelectorAll('.contacts-control-section')]
        .find((candidate) => candidate.innerText.includes('공유 정책'));
      [...section.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '동의 후 공유').click();
    })()
  `);
  await waitForExpression(
    cdp,
    `[...document.querySelectorAll('.contacts-control-section')]
      .find((candidate) => candidate.innerText.includes('공유 정책'))
      ?.querySelectorAll('button')
      && [...[...document.querySelectorAll('.contacts-control-section')]
        .find((candidate) => candidate.innerText.includes('공유 정책')).querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '동의 후 공유')?.dataset.active === 'true'`,
    "Shared policy selection did not become active."
  );
  await evaluate(cdp, `
    (() => {
      const section = [...document.querySelectorAll('.contacts-control-section')]
        .find((candidate) => candidate.innerText.includes('공유 정책'));
      [...section.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === '정책 적용').click();
    })()
  `);
  await waitForExpression(cdp, `document.body.innerText.includes('공유 정책을 적용했습니다.')`, "Installed renderer did not apply the shared family policy.");

  await logoutRenderer(cdp, "Owner did not return to login before member consent.");
  await loginRenderer(cdp, guestEmail, guestPassword, "Guest could not log in for family consent.");
  await openContacts(cdp, "Guest contacts desk did not open for consent.");
  await waitForExpression(cdp, `document.body.innerText.includes(${JSON.stringify(contactGroupMarker)}) && Boolean(document.querySelector('.consent-main-actions'))`, "Guest did not receive the scoped family consent request.");
  await evaluate(cdp, `document.querySelector('.consent-main-actions .primary-button').click()`);
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('.contact-roster-view')) && document.querySelectorAll('.contact-member-item').length === 2`,
    "Consenting guest did not receive the owner-and-self family roster."
  );
  assert(
    await evaluate(cdp, `!document.body.innerText.includes(${JSON.stringify(contactPrivateMarker)})`),
    "Consented shared roster exposed owner-private relationship notes."
  );
  await captureScreenshot(cdp, contactsMemberScreenshotPath, "Consented member contacts screenshot is unexpectedly small.");

  await logoutRenderer(cdp, "Guest did not return to login before the media desk check.");
  await loginRenderer(cdp, "you@inviz.co.kr", password, "Owner could not log in for the media desk check.");
  await waitForExpression(cdp, `Boolean(document.querySelector('.composer-media-mode'))`, "Installed media composer controls did not render.");
  assert(
    await evaluate(cdp, `typeof navigator.mediaDevices?.getDisplayMedia === 'function' && !document.querySelector('button[title="화면 캡처"]').disabled`),
    "Installed renderer did not expose the consent-gated screen capture entry point."
  );

  const mediaMarker = Date.now();
  const imageFileName = `stage5-renderer-${mediaMarker}.png`;
  const imageContent = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  await evaluate(cdp, `
    [...document.querySelectorAll('.composer-media-mode button')]
      .find((button) => button.textContent.includes('대상 공유')).click()
  `);
  await injectRendererFile(cdp, imageFileName, "image/png", imageContent);
  await waitForExpression(
    cdp,
    `[...document.querySelectorAll('.media-library-main strong')].some((node) => node.textContent === ${JSON.stringify(imageFileName)})
      && document.querySelector('.media-upload-status .tiny')?.textContent.includes('완료')`,
    "Installed renderer did not complete and persist the image upload."
  );
  await evaluate(cdp, `
    [...document.querySelectorAll('.media-library-main')]
      .find((button) => button.innerText.includes(${JSON.stringify(imageFileName)})).click()
  `);
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('.file-preview img')?.complete && document.querySelector('.file-preview img')?.naturalWidth > 0)`,
    "Authenticated installed image preview did not render."
  );

  const pdfFileName = `stage5-document-${mediaMarker}.pdf`;
  await evaluate(cdp, `
    [...document.querySelectorAll('.composer-media-mode button')]
      .find((button) => button.textContent.includes('내 보관')).click()
  `);
  await injectRendererFile(cdp, pdfFileName, "application/pdf", createMinimalPdf("HahaTalk Stage 5 PDF"));
  await waitForExpression(
    cdp,
    `document.querySelector('.pdf-file-name')?.textContent === ${JSON.stringify(pdfFileName)}`,
    "Installed renderer did not complete the private PDF upload."
  );
  await waitForExpression(
    cdp,
    `Boolean(document.querySelector('canvas.pdf-canvas')?.width > 100 && document.querySelector('canvas.pdf-canvas')?.height > 100)`,
    "PDF.js did not render the authenticated installed PDF."
  );

  const objectFiles = await readdir(path.join(path.dirname(statusPath), "objects"), { recursive: true });
  assert(objectFiles.some((entry) => String(entry).endsWith("original")), "Installed media bytes were not written under the private app object root.");
  assert(objectFiles.some((entry) => String(entry).endsWith("shared-preview")), "Installed shared image derivative was not created.");
  await captureScreenshot(cdp, mediaScreenshotPath, "Installed media desk screenshot is unexpectedly small.");

  await evaluate(cdp, `document.querySelector('button[title="패널 팝업"]').click()`);
  const popoutTarget = await waitForAdditionalTarget(debugPort, target.id);
  const popoutCdp = await connectCdp(popoutTarget.webSocketDebuggerUrl);
  try {
    await popoutCdp.send("Page.enable");
    await popoutCdp.send("Runtime.enable");
    await waitForExpression(
      popoutCdp,
      `location.search.includes('panel=pdf')
        && document.querySelector('.pdf-file-name')?.textContent === ${JSON.stringify(pdfFileName)}
        && Boolean(document.querySelector('canvas.pdf-canvas')?.width > 100)`,
      "PDF pop-out did not preserve its selected private document and rendered canvas."
    );
    await popoutCdp.send("Page.close").catch(() => evaluate(popoutCdp, "window.close()"));
  } finally {
    popoutCdp.close();
  }

  await logoutRenderer(cdp, "Guest renderer logout did not return to login.");
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
  assert(!(await isPortOpen(runtime.databasePort)), "Embedded PostgreSQL remained reachable after renderer smoke shutdown.");
  console.log(`Windows renderer invitation, contacts, and media check passed: ${runtime.version}, owner ${screenshotPath}, guest ${guestScreenshotPath}, contacts ${contactsOwnerScreenshotPath}, member ${contactsMemberScreenshotPath}, media ${mediaScreenshotPath}`);
} finally {
  if (isProcessRunning(application.pid)) {
    await Promise.race([
      cdp?.send("Browser.close").catch(() => undefined) ?? Promise.resolve(),
      delay(1_000)
    ]);
    for (let attempt = 0; attempt < 30 && isProcessRunning(application.pid); attempt += 1) {
      await delay(200);
    }
  }
  cdp?.close();
  if (isProcessRunning(application.pid)) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(application.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      application.kill();
    }
  }
  if (runtime?.databaseMode === "embedded-postgresql" && await isPortOpen(runtime.databasePort)) {
    const pgCtl = path.join(path.dirname(executablePath), "resources", "runtime", "postgres", "bin", "pg_ctl.exe");
    const dataDirectory = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "HahaTalk", "postgres-data");
    execFileSync(pgCtl, ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
  }
  await rm(statusPath, { force: true });
}
