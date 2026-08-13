import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchCurrentUser, isApiAuthError, mockMode } from "../api";
import { signInWithGoogle, signOutBrowser } from "./client";

type AuthStatus = "unknown" | "anonymous" | "authenticating" | "authenticated" | "reauthRequired";

export interface AuthUser {
  email: string;
  displayName: string;
  role: "owner" | "editor";
  expiresAt: number | null;
}

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  displayInfo: { email: string; displayName: string } | null;
  loginWithGoogleButton(): Promise<AuthUser>;
  signOut(): void;
  /** Ensures the server session is present; it never returns a browser credential. */
  requireValidCredential(): Promise<void>;
  forceUpdateToken: number;
}

const SESSION_KEY = "songbook:display-user";

export class AuthRequiredError extends Error {
  readonly code = "AUTH_REQUIRED";
  constructor(message = "기록하려면 Google 로그인이 필요해.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

const defaultContext: AuthContextValue = {
  status: "unknown",
  user: null,
  displayInfo: null,
  async loginWithGoogleButton() {
    throw new AuthRequiredError();
  },
  signOut() {
    /* noop */
  },
  async requireValidCredential() {
    throw new AuthRequiredError();
  },
  forceUpdateToken: 0
};

const AuthContext = createContext<AuthContextValue>(defaultContext);

function readSessionDisplay(): { email: string; displayName: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { email?: string; displayName?: string };
    if (parsed.email && parsed.displayName) return { email: parsed.email, displayName: parsed.displayName };
  } catch {
    /* ignore */
  }
  return null;
}

function writeSessionDisplay(value: { email: string; displayName: string } | null) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function userFromCurrent(current: { email: string; displayName: string; role: "owner" | "editor" }): AuthUser {
  return { ...current, expiresAt: null };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("unknown");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [displayInfo, setDisplayInfo] = useState<{ email: string; displayName: string } | null>(() => readSessionDisplay());
  const [forceUpdateToken, setForceUpdateToken] = useState(0);

  const adoptServerUser = useCallback((current: { email: string; displayName: string; role: "owner" | "editor" }) => {
    const next = userFromCurrent(current);
    setUser(next);
    setDisplayInfo({ email: next.email, displayName: next.displayName });
    writeSessionDisplay({ email: next.email, displayName: next.displayName });
    setStatus("authenticated");
    setForceUpdateToken((token) => token + 1);
    return next;
  }, []);

  const refreshUser = useCallback(async (): Promise<AuthUser | null> => {
    try {
      return adoptServerUser(await fetchCurrentUser());
    } catch (error) {
      setUser(null);
      setStatus(isApiAuthError(error) ? "anonymous" : "anonymous");
      return null;
    }
  }, [adoptServerUser]);

  const loginWithGoogleButton = useCallback(async (): Promise<AuthUser> => {
    if (mockMode()) {
      return adoptServerUser({ email: "owner@example.com", displayName: "마리", role: "owner" });
    }
    setStatus("authenticating");
    try {
      await signInWithGoogle();
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      setStatus("reauthRequired");
      const message = error instanceof Error && error.message
        ? error.message
        : "Google 로그인을 시작하지 못했어.";
      throw new AuthRequiredError(message);
    }
    throw new AuthRequiredError("Google 로그인 화면으로 이동했어.");
  }, [adoptServerUser]);

  const signOut = useCallback(() => {
    if (!mockMode()) void signOutBrowser();
    setUser(null);
    setDisplayInfo(null);
    writeSessionDisplay(null);
    setStatus("anonymous");
    setForceUpdateToken((token) => token + 1);
  }, []);

  const requireValidCredential = useCallback(async (): Promise<void> => {
    if (user) return;
    const current = await refreshUser();
    if (current) return;
    setStatus("reauthRequired");
    await loginWithGoogleButton();
  }, [loginWithGoogleButton, refreshUser, user]);

  useEffect(() => {
    if (status !== "unknown") return;
    void refreshUser().then((current) => {
      if (!current && displayInfo) setStatus("reauthRequired");
    });
  }, [displayInfo, refreshUser, status]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, displayInfo, loginWithGoogleButton, signOut, requireValidCredential, forceUpdateToken }),
    [status, user, displayInfo, loginWithGoogleButton, signOut, requireValidCredential, forceUpdateToken]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
