import NetInfo from "@react-native-community/netinfo";
import type { SendConversationMessageInput } from "@hahatalk/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren
} from "react";
import { ApiError, mobileApi } from "../lib/api-client";
import {
  enqueueOfflineMessage,
  flushOfflineQueue,
  readOfflineQueue,
  retryFailedOfflineMessages,
  subscribeOfflineQueue
} from "../lib/offline-queue";
import { useAuth } from "./auth-provider";

type SendResult = { queued: true } | { queued: false; response: unknown };
type ConnectivityContextValue = {
  connected: boolean;
  failedCount: number;
  pendingCount: number;
  syncing: boolean;
  flushNow: () => Promise<void>;
  retryFailed: () => Promise<void>;
  sendMessage: (input: SendConversationMessageInput) => Promise<SendResult>;
};

const ConnectivityContext = createContext<ConnectivityContextValue | null>(null);

export function ConnectivityProvider({ children }: PropsWithChildren) {
  const { session } = useAuth();
  const [connected, setConnected] = useState(true);
  const [failedCount, setFailedCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const flushing = useRef(false);
  const ownerId = session?.session.user.id;

  const refreshCounts = useCallback(async () => {
    if (!ownerId) {
      setFailedCount(0);
      setPendingCount(0);
      return;
    }
    const items = await readOfflineQueue(ownerId).catch(() => []);
    setFailedCount(items.filter((item) => item.state === "failed").length);
    setPendingCount(items.filter((item) => item.state === "pending").length);
  }, [ownerId]);

  const flushNow = useCallback(async () => {
    if (!ownerId || !connected || flushing.current) return;
    flushing.current = true;
    setSyncing(true);
    try {
      await flushOfflineQueue(ownerId);
      await refreshCounts();
    } finally {
      flushing.current = false;
      setSyncing(false);
    }
  }, [connected, ownerId, refreshCounts]);

  useEffect(() => NetInfo.addEventListener((state) => {
    setConnected(state.isConnected === true && state.isInternetReachable !== false);
  }), []);

  useEffect(() => {
    void refreshCounts();
    return subscribeOfflineQueue(() => void refreshCounts());
  }, [refreshCounts]);

  useEffect(() => {
    if (connected && ownerId) void flushNow();
  }, [connected, flushNow, ownerId]);

  const sendMessage = useCallback(async (input: SendConversationMessageInput): Promise<SendResult> => {
    if (!ownerId) throw new Error("Sign in is required.");
    if (!connected) {
      await enqueueOfflineMessage(ownerId, input);
      return { queued: true };
    }
    try {
      const response = await mobileApi.request("/messages", {
        body: input as unknown as Record<string, unknown>,
        method: "POST"
      });
      return { queued: false, response };
    } catch (cause) {
      const retryable = !(cause instanceof ApiError)
        || cause.status === 408
        || cause.status === 429
        || cause.status >= 500;
      if (!retryable) throw cause;
      await enqueueOfflineMessage(ownerId, input);
      return { queued: true };
    }
  }, [connected, ownerId]);

  const retryFailed = useCallback(async () => {
    if (!ownerId) return;
    await retryFailedOfflineMessages(ownerId);
    await flushNow();
  }, [flushNow, ownerId]);

  const value = useMemo<ConnectivityContextValue>(() => ({
    connected,
    failedCount,
    flushNow,
    pendingCount,
    retryFailed,
    sendMessage,
    syncing
  }), [connected, failedCount, flushNow, pendingCount, retryFailed, sendMessage, syncing]);

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity() {
  const value = useContext(ConnectivityContext);
  if (!value) throw new Error("useConnectivity must be used inside ConnectivityProvider.");
  return value;
}
