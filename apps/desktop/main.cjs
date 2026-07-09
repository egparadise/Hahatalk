const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("node:path");

const webUrl = process.env.HAHATALK_WEB_URL || "http://127.0.0.1:3000";

function createWindow(route = "") {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: "HahaTalk",
    backgroundColor: "#f6f7f4",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(webUrl) || url.startsWith("about:blank")) {
      createWindow();
      return { action: "deny" };
    }

    shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });

  win.loadURL(`${webUrl}${route}`).catch(() => undefined);
  return win;
}

const template = [
  {
    label: "HahaTalk",
    submenu: [
      {
        label: "새 채팅 창",
        accelerator: "CmdOrCtrl+Shift+N",
        click: () => createWindow()
      },
      { type: "separator" },
      { role: "quit", label: "종료" }
    ]
  },
  {
    label: "보기",
    submenu: [
      { role: "reload", label: "새로고침" },
      { role: "toggleDevTools", label: "개발자 도구" },
      { type: "separator" },
      { role: "resetZoom", label: "기본 확대" },
      { role: "zoomIn", label: "확대" },
      { role: "zoomOut", label: "축소" },
      { role: "togglefullscreen", label: "전체 화면" }
    ]
  }
];

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

