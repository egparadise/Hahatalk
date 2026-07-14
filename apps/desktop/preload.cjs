const { contextBridge, ipcRenderer } = require("electron");

function readArgument(prefix, fallback = undefined) {
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

contextBridge.exposeInMainWorld("hahaTalkDesktop", {
  apiBaseUrl: readArgument("--hahatalk-api-url=", "http://127.0.0.1:4000"),
  isDesktop: true,
  isPackaged: readArgument("--hahatalk-packaged=", "0") === "1",
  platform: process.platform,
  remoteSupport: {
    onStatus(listener) {
      const handler = (_event, status) => listener(status);
      ipcRenderer.on("remote-support:agent-status", handler);
      return () => ipcRenderer.removeListener("remote-support:agent-status", handler);
    },
    startAgent(payload) {
      return ipcRenderer.invoke("remote-support:start-agent", payload);
    },
    status() {
      return ipcRenderer.invoke("remote-support:agent-status");
    },
    stopAgent() {
      return ipcRenderer.invoke("remote-support:stop-agent");
    }
  },
  version: readArgument("--hahatalk-version=", "0.1.0")
});
