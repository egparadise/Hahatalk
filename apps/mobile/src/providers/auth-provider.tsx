import type { MobileAuthView } from "@hahatalk/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren
} from "react";
import { mobileApi } from "../lib/api-client";
import { ensureOfflineQueueOwner, clearOfflineQueue } from "../lib/offline-queue";
import {
  clearMobileSession,
  getInstallationId,
  loadMobileSession,
  saveMobileSession
} from "../lib/session-store";

type AuthContextValue = {
  booting: boolean;
  busy: boolean;
  error: string | null;
  installationId: string;
  session: MobileAuthView | null;
  clearError: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState("");
  const [session, setSession] = useState<MobileAuthView | null>(null);

  const persistSession = useCallback(async (next: MobileAuthView | null) => {
    setSession(next);
    if (next) await saveMobileSession(next);
    else await clearMobileSession();
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([getInstallationId(), loadMobileSession()])
      .then(([id, stored]) => {
        if (!active) return;
        setInstallationId(id);
        setSession(stored);
        mobileApi.configure(stored, id, persistSession);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Secure session storage failed.");
      })
      .finally(() => {
        if (active) setBooting(false);
      });
    return () => {
      active = false;
    };
  }, [persistSession]);

  const signIn = useCallback(async (email: string, password: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await mobileApi.login(email, password);
      await ensureOfflineQueueOwner(next.session.user.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Sign in failed.";
      setError(message);
      throw cause;
    } finally {
      setBusy(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await mobileApi.logout();
      await clearOfflineQueue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign out failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    booting,
    busy,
    clearError: () => setError(null),
    error,
    installationId,
    session,
    signIn,
    signOut
  }), [booting, busy, error, installationId, session, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
