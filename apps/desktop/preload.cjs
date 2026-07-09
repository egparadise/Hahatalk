const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("hahaTalkDesktop", {
  platform: process.platform,
  isDesktop: true
});

