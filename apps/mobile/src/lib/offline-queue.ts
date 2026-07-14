import type { SendConversationMessageInput } from "@hahatalk/contracts";
import {
  AESEncryptionKey,
  AESKeySize,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
  digestStringAsync,
  CryptoDigestAlgorithm,
  randomUUID
} from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";
import { ApiError, mobileApi } from "./api-client";

export type QueuedMessage = {
  id: string;
  createdAt: string;
  attempts: number;
  state: "pending" | "failed";
  input: SendConversationMessageInput;
  lastError?: string;
};

type QueueEnvelope = {
  version: 1;
  ownerHash: string;
  ciphertext: string;
};

const storageKey = "hahatalk.offline.queue.v1";
const encryptionKey = "hahatalk.offline.queue.key.v1";
const maximumItems = 50;
const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  keychainService: "kr.co.inviz.hahatalk.offline"
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const listeners = new Set<() => void>();

function aad(ownerUserId: string) {
  return encoder.encode(`hahatalk:offline:v1:${ownerUserId}`);
}

async function ownerHash(ownerUserId: string) {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, ownerUserId);
}

async function queueKey(create: boolean) {
  const existing = await SecureStore.getItemAsync(encryptionKey, secureOptions);
  if (existing) return AESEncryptionKey.import(existing, "base64");
  if (!create) return null;
  const generated = await AESEncryptionKey.generate(AESKeySize.AES256);
  await SecureStore.setItemAsync(encryptionKey, await generated.encoded("base64"), secureOptions);
  return generated;
}

async function readEnvelope(): Promise<QueueEnvelope | null> {
  const stored = await Storage.getItem(storageKey);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<QueueEnvelope>;
    if (parsed.version === 1 && typeof parsed.ownerHash === "string" && typeof parsed.ciphertext === "string") {
      return parsed as QueueEnvelope;
    }
  } catch {
    // Invalid local data is cleared by the caller.
  }
  return null;
}

export async function readOfflineQueue(ownerUserId: string): Promise<QueuedMessage[]> {
  const envelope = await readEnvelope();
  if (!envelope) return [];
  if (envelope.ownerHash !== await ownerHash(ownerUserId)) throw new Error("Offline queue belongs to another account.");
  const key = await queueKey(false);
  if (!key) throw new Error("Offline queue key is unavailable.");
  const sealed = AESSealedData.fromCombined(envelope.ciphertext);
  const plaintext = await aesDecryptAsync(sealed, key, { additionalData: aad(ownerUserId), output: "bytes" });
  const parsed: unknown = JSON.parse(decoder.decode(plaintext));
  if (!Array.isArray(parsed)) throw new Error("Offline queue payload is invalid.");
  return parsed as QueuedMessage[];
}

async function writeOfflineQueue(ownerUserId: string, items: QueuedMessage[]) {
  if (!items.length) {
    await Storage.removeItem(storageKey);
    emit();
    return;
  }
  const key = await queueKey(true);
  const sealed = await aesEncryptAsync(encoder.encode(JSON.stringify(items)), key!, {
    additionalData: aad(ownerUserId),
    nonce: { length: 12 },
    tagLength: 16
  });
  const envelope: QueueEnvelope = {
    ciphertext: await sealed.combined("base64"),
    ownerHash: await ownerHash(ownerUserId),
    version: 1
  };
  await Storage.setItem(storageKey, JSON.stringify(envelope));
  emit();
}

export async function ensureOfflineQueueOwner(ownerUserId: string) {
  const envelope = await readEnvelope();
  if (envelope && envelope.ownerHash !== await ownerHash(ownerUserId)) await clearOfflineQueue();
}

export async function enqueueOfflineMessage(ownerUserId: string, input: SendConversationMessageInput) {
  let items: QueuedMessage[];
  try {
    items = await readOfflineQueue(ownerUserId);
  } catch {
    await clearOfflineQueue();
    items = [];
  }
  if (items.length >= maximumItems) throw new Error("Offline queue is full. Reconnect before sending more messages.");
  const queued: QueuedMessage = {
    attempts: 0,
    createdAt: new Date().toISOString(),
    id: randomUUID(),
    input,
    state: "pending"
  };
  await writeOfflineQueue(ownerUserId, [...items, queued]);
  return queued;
}

export async function flushOfflineQueue(ownerUserId: string) {
  let items = await readOfflineQueue(ownerUserId).catch(async () => {
    await clearOfflineQueue();
    return [];
  });
  let delivered = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.state === "failed") continue;
    try {
      await mobileApi.request("/messages", { body: item.input as unknown as Record<string, unknown>, method: "POST" });
      items = items.filter((candidate) => candidate.id !== item.id);
      index -= 1;
      delivered += 1;
      await writeOfflineQueue(ownerUserId, items);
    } catch (error) {
      const retryable = !(error instanceof ApiError) || error.status === 408 || error.status === 429 || error.status >= 500;
      const next: QueuedMessage = {
        ...item,
        attempts: item.attempts + 1,
        lastError: error instanceof Error ? error.message : "Message delivery failed.",
        state: retryable && item.attempts < 4 ? "pending" : "failed"
      };
      items = items.map((candidate) => candidate.id === item.id ? next : candidate);
      await writeOfflineQueue(ownerUserId, items);
      if (retryable) break;
    }
  }
  return { delivered, items };
}

export async function retryFailedOfflineMessages(ownerUserId: string) {
  const items = await readOfflineQueue(ownerUserId);
  await writeOfflineQueue(ownerUserId, items.map((item) => ({ ...item, attempts: 0, state: "pending" })));
}

export async function clearOfflineQueue() {
  await Promise.all([
    Storage.removeItem(storageKey),
    SecureStore.deleteItemAsync(encryptionKey, secureOptions)
  ]);
  emit();
}

export function subscribeOfflineQueue(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit() {
  for (const listener of listeners) listener();
}
