const { contextBridge } = require("electron");

function readArgument(prefix, fallback = undefined) {
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

contextBridge.exposeInMainWorld("hahaTalkDesktop", {
  apiBaseUrl: readArgument("--hahatalk-api-url=", "http://127.0.0.1:4000"),
  isDesktop: true,
  isPackaged: readArgument("--hahatalk-packaged=", "0") === "1",
  platform: process.platform,
  version: readArgument("--hahatalk-version=", "0.1.0")
});
