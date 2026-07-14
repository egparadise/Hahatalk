import type { MobileAuthView } from "@hahatalk/contracts";
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const sessionKey = "hahatalk.mobile.session.v1";
const installationKey = "hahatalk.mobile.installation.v1";
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  keychainService: "kr.co.inviz.hahatalk.session"
};

function isMobileSession(value: unknown): value is MobileAuthView {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MobileAuthView>;
  return typeof candidate.accessToken === "string"
    && candidate.accessToken.startsWith("hha_")
    && typeof candidate.refreshToken === "string"
    && candidate.refreshToken.startsWith("hhr_")
    && typeof candidate.session?.user?.id === "string";
}

export async function loadMobileSession(): Promise<MobileAuthView | null> {
  const stored = await SecureStore.getItemAsync(sessionKey, secureOptions);
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (isMobileSession(value)) return value;
  } catch {
    // Corrupt credentials are removed below.
  }
  await SecureStore.deleteItemAsync(sessionKey, secureOptions);
  return null;
}

export async function saveMobileSession(session: MobileAuthView) {
  await SecureStore.setItemAsync(sessionKey, JSON.stringify(session), secureOptions);
}

export async function clearMobileSession() {
  await SecureStore.deleteItemAsync(sessionKey, secureOptions);
}

export async function getInstallationId() {
  const existing = await SecureStore.getItemAsync(installationKey, secureOptions);
  if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
    return existing;
  }
  const created = randomUUID();
  await SecureStore.setItemAsync(installationKey, created, secureOptions);
  return created;
}
