const path = require("node:path");

module.exports = {
  packagerConfig: {
    appBundleId: "com.inviz.hahatalk",
    appCopyright: "Copyright (c) 2026 Inviz",
    asar: true,
    executableName: "HahaTalk",
    extraResource: [path.join(__dirname, "runtime")],
    icon: path.join(__dirname, "assets", "hahatalk.ico"),
    ignore: [/^\/node_modules(?:\/|$)/, /^\/runtime(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/out(?:\/|$)/],
    name: "HahaTalk",
    overwrite: true,
    prune: false,
    win32metadata: {
      CompanyName: "Inviz",
      FileDescription: "HahaTalk Windows Desktop Messenger",
      InternalName: "HahaTalk",
      OriginalFilename: "HahaTalk.exe",
      ProductName: "HahaTalk"
    }
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        authors: "Inviz",
        description: "HahaTalk Windows desktop messenger",
        name: "HahaTalk",
        noMsi: true,
        setupExe: "HahaTalkSetup.exe",
        setupIcon: path.join(__dirname, "assets", "hahatalk.ico")
      }
    }
  ]
};
