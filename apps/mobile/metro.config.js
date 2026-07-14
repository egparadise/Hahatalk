const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const mobileReactRoot = path.dirname(require.resolve("react/package.json", { paths: [__dirname] }));

// Hoisted workspace packages must use the same React instance as the Expo app.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react" || moduleName.startsWith("react/")) {
    const subpath = moduleName === "react" ? "index.js" : moduleName.slice("react/".length);
    return {
      filePath: require.resolve(path.join(mobileReactRoot, subpath)),
      type: "sourceFile"
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
