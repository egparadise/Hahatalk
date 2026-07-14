import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const mobileRoot = path.join(root, "apps", "mobile");
const requireBundles = process.argv.includes("--require-bundles");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  const filePath = path.join(root, relativePath);
  assert(existsSync(filePath), `Missing mobile file: ${relativePath}`);
  return readFileSync(filePath, "utf8");
}

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(item) : [item];
  });
}

const requiredFiles = [
  "apps/mobile/app.config.ts",
  "apps/mobile/metro.config.js",
  "apps/mobile/eas.json",
  "apps/mobile/app/_layout.tsx",
  "apps/mobile/app/(auth)/sign-in.tsx",
  "apps/mobile/app/(app)/(tabs)/chats.tsx",
  "apps/mobile/app/(app)/(tabs)/calendar.tsx",
  "apps/mobile/app/(app)/(tabs)/live.tsx",
  "apps/mobile/app/(app)/(tabs)/settings.tsx",
  "apps/mobile/app/(app)/space/[spaceId].tsx",
  "apps/mobile/app/(app)/media/[assetId].tsx",
  "apps/mobile/app/(app)/call/[callId].tsx",
  "apps/mobile/app/(app)/meeting/[meetingId].tsx",
  "apps/mobile/app/(app)/broadcast/[sessionId].tsx",
  "apps/mobile/src/lib/api-client.ts",
  "apps/mobile/src/lib/notifications.ts",
  "apps/mobile/src/lib/offline-queue.ts",
  "apps/mobile/src/lib/session-store.ts"
];
requiredFiles.forEach(read);

const pkg = JSON.parse(read("apps/mobile/package.json"));
const config = read("apps/mobile/app.config.ts");
const metro = read("apps/mobile/metro.config.js");
const api = read("apps/mobile/src/lib/api-client.ts");
const notifications = read("apps/mobile/src/lib/notifications.ts");
const offline = read("apps/mobile/src/lib/offline-queue.ts");
const session = read("apps/mobile/src/lib/session-store.ts");
const capabilities = read("apps/api/src/mobile/mobile.service.ts");
const conversation = read("apps/api/src/modules/conversation.service.ts");

assert(pkg.version === "0.17.0" && pkg.main === "expo-router/entry", "Mobile package identity or version is invalid.");
assert(pkg.scripts?.["export:android"] && pkg.scripts?.["export:ios"], "Both native bundle export scripts are required.");
assert(pkg.dependencies?.["expo-secure-store"] && pkg.dependencies?.["expo-sqlite"], "SecureStore and SQLite are required.");
assert(config.includes("android.permission.RECORD_AUDIO") && config.includes("NSMicrophoneUsageDescription"), "Call microphone permission is missing.");
assert(config.includes("00000000-0000-0000-0000-000000000000"), "Push registration must remain fail-closed until a real EAS project is configured.");
assert(metro.includes("mobileReactRoot") && metro.includes("resolveRequest"), "Metro must pin one React instance for the mobile bundle.");
assert(api.includes("must use HTTPS outside local development") && api.includes('"X-HahaTalk-Client": "mobile-v1"'), "Mobile transport policy is incomplete.");
assert(api.includes("ensureFreshAccess") && api.includes("error.status === 401 || error.status === 403"), "Refresh rotation must distinguish auth failure from network failure.");
assert(session.includes("SecureStore") && !session.includes("AsyncStorage"), "Tokens must only use OS secure storage.");
assert(offline.includes("AESEncryptionKey") && offline.includes("AESSealedData") && offline.includes("maximumItems = 50"), "Offline mutations must be bounded and AES-GCM encrypted.");
assert(notifications.includes("routePattern") && notifications.includes("AndroidNotificationVisibility.PRIVATE"), "Notification routes and lock-screen privacy are required.");
assert(capabilities.includes("available: false") && capabilities.includes("never bundled into the mobile companion"), "Mobile remote control must remain unavailable.");
assert(
  capabilities.includes("materializePushEvents")
    && capabilities.includes("'call.invite'")
    && capabilities.includes("'meeting.lobby'")
    && capabilities.includes("'broadcast.started'"),
  "Call, meeting, and broadcast push materialization is incomplete."
);
assert(
  conversation.includes("\\uC0C8 \\uBA54\\uC2DC\\uC9C0")
    && conversation.includes("jsonb_build_object('route', $3::text, 'eventType', 'conversation.message')"),
  "Generic mobile message push policy is missing."
);

const mobileSource = ["app", "src"].flatMap((directory) => filesBelow(path.join(mobileRoot, directory)))
  .filter((file) => /\.(?:ts|tsx|js)$/.test(file) && !file.includes(`${path.sep}dist${path.sep}`))
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
assert(!mobileSource.includes("SendInput"), "Windows native input injection must never enter the mobile bundle.");

if (requireBundles) {
  for (const platform of ["android", "ios"]) {
    const outputRoot = path.join(mobileRoot, "dist", platform);
    assert(existsSync(path.join(outputRoot, "metadata.json")), `${platform} export metadata is missing.`);
    const bundles = filesBelow(outputRoot).filter((file) => file.endsWith(".hbc"));
    assert(bundles.length === 1, `${platform} must contain exactly one Hermes bundle.`);
    assert(statSync(bundles[0]).size > 1_000_000, `${platform} Hermes bundle is unexpectedly small.`);
  }
}

console.log(`Mobile bundle check passed${requireBundles ? " with Android and iOS Hermes exports" : ""}.`);
