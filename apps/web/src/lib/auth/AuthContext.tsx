import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchCurrentUser as apiFetchCurrentUser, isApiAuthError } from "../api";
import { isJwtExpired, jwtExpiresAt } from "@songbook/shared";
import { loadGoogleIdentityScript } from "../googleIdentity";
import { betterAuthConfigured, getBetterAuthSession, signInWithGoogle, signInWithGoogleIdToken, signOutBetterAuth } from "./client";

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
  credentialExpiresAt: number | null;
  // Display-only data persisted across reloads so the header can still show
  // "마리" before login is re-confirmed. The actual credential is not stored.
  displayInfo: { email: string; displayName: string } | null;
  loginWithCredential(credential: string): Promise<AuthUser>;
  loginWithGoogleButton(): Promise<AuthUser>;
  signOut(): void;
  // Returns a valid credential or throws `AuthRequiredError`. Callers should
  // never call a write API without one.
  requireValidCredential(): Promise<string>;
  // Re-render trigger for components that react to auth state changes.
  forceUpdateToken: number;
}

const SESSION_KEY = "songbook:display-user";
const GIS_PROMPT_TIMEOUT_MS = 1500;

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
  credentialExpiresAt: null,
  displayInfo: null,
  async loginWithCredential() {
    throw new AuthRequiredError();
  },
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

interface PendingAction {
  resolve(value: string): void;
  reject(error: Error): void;
}

interface AuthProviderProps {
  clientId: string | undefined;
  children: ReactNode;
}

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

export function AuthProvider({ clientId, children }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>("unknown");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [credentialExpiresAt, setCredentialExpiresAt] = useState<number | null>(null);
  const [displayInfo, setDisplayInfo] = useState<{ email: string; displayName: string } | null>(() => readSessionDisplay());
  const [forceUpdateToken, setForceUpdateToken] = useState(0);

  const credentialRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);
  const gisInitRef = useRef(false);
  const betterAuthMode = betterAuthConfigured();

  const clearCredential = useCallback(() => {
    credentialRef.current = null;
    setCredentialExpiresAt(null);
    setStatus("reauthRequired");
    setForceUpdateToken((token) => token + 1);
  }, []);

  const adoptCredential = useCallback(async (credential: string): Promise<AuthUser> => {
    if (!credential) throw new AuthRequiredError();
    if (isJwtExpired(credential)) {
      // Reject expired tokens before contacting the server: we will never
      // treat an expired credential as authenticated.
      setStatus("reauthRequired");
      setForceUpdateToken((token) => token + 1);
      throw new AuthRequiredError("로그인이 만료됐어. 다시 로그인해줘.");
    }
    credentialRef.current = credential;
    const expiresAt = jwtExpiresAt(credential);
    setCredentialExpiresAt(expiresAt);
    try {
      const current = await apiFetchCurrentUser(credential);
      const next: AuthUser = {
        email: current.email,
        displayName: current.displayName,
        role: current.role,
        expiresAt
      };
      setUser(next);
      setDisplayInfo({ email: current.email, displayName: current.displayName });
      writeSessionDisplay({ email: current.email, displayName: current.displayName });
      setStatus("authenticated");
      setForceUpdateToken((token) => token + 1);
      return next;
    } catch (error) {
      credentialRef.current = null;
      setCredentialExpiresAt(null);
      setUser(null);
      if (isApiAuthError(error) || (error instanceof Error && /UNAUTHORIZED|FORBIDDEN/i.test(error.message))) {
        setStatus("reauthRequired");
      } else {
        setStatus("anonymous");
      }
      setForceUpdateToken((token) => token + 1);
      throw error instanceof Error ? error : new Error("로그인 실패");
    }
  }, []);

  const loginWithCredential = useCallback(
    async (credential: string) => {
      setStatus("authenticating");
      try {
        if (betterAuthMode) {
          await signInWithGoogleIdToken(credential);
          const session = await getBetterAuthSession();
          if (!session) throw new AuthRequiredError("Better Auth 세션을 만들지 못했어.");
          const next: AuthUser = {
            email: session.user.email,
            displayName: session.user.name,
            role: session.user.role,
            expiresAt: typeof session.session.expiresAt === "number" ? session.session.expiresAt : new Date(session.session.expiresAt).getTime()
          };
          setUser(next);
          setDisplayInfo({ email: next.email, displayName: next.displayName });
          writeSessionDisplay({ email: next.email, displayName: next.displayName });
          setCredentialExpiresAt(next.expiresAt);
          setStatus("authenticated");
          setForceUpdateToken((token) => token + 1);
          return next;
        }
        const next = await adoptCredential(credential);
        const pending = pendingRef.current;
        if (pending) {
          pendingRef.current = null;
          pending.resolve(credential);
        }
        return next;
      } catch (error) {
        const pending = pendingRef.current;
        if (pending) {
          pendingRef.current = null;
          pending.reject(error instanceof Error ? error : new Error("로그인 실패"));
        }
        throw error;
      }
    },
    [adoptCredential, betterAuthMode]
  );

  const loginWithGoogleButton = useCallback(async () => {
    if (betterAuthMode) {
      setStatus("authenticating");
      await signInWithGoogle();
      throw new AuthRequiredError("Google 로그인 화면으로 이동했어.");
    }
    if (!clientId) throw new AuthRequiredError("Google 로그인이 설정되지 않았어.");
    setStatus("authenticating");
    const accounts = await loadGoogleIdentityScript();
    return new Promise<AuthUser>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error, credential?: string | null) => {
        if (settled) return;
        settled = true;
        if (err) {
          setStatus("reauthRequired");
          setForceUpdateToken((token) => token + 1);
          reject(err);
          return;
        }
        if (!credential) {
          setStatus("reauthRequired");
          setForceUpdateToken((token) => token + 1);
          reject(new AuthRequiredError("Google 로그인이 취소됐어."));
          return;
        }
        loginWithCredential(credential).then((user) => resolve(user)).catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
      };
      try {
        accounts.initialize({
          client_id: clientId,
          callback: (response) => finish(undefined, response.credential ?? null)
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Google 로그인 초기화 실패"));
        return;
      }
      accounts.prompt?.((notification) => {
        if (notification.isNotDisplayed?.() || notification.isSkippedMoment?.() || notification.isDismissedMoment?.()) {
          finish(new AuthRequiredError("Google 로그인 창을 띄울 수 없어. 로그인 버튼을 눌러줘."));
        }
      });
      // If the GIS prompt produces no signal within the timeout, surface a
      // request for the user to tap the button rather than hang forever.
      window.setTimeout(() => {
        if (!settled) finish(new AuthRequiredError("Google 로그인 응답이 없어. 버튼을 직접 눌러줘."));
      }, GIS_PROMPT_TIMEOUT_MS);
    });
  }, [betterAuthMode, clientId, loginWithCredential]);

  const signOut = useCallback(() => {
    if (betterAuthMode) signOutBetterAuth();
    credentialRef.current = null;
    setCredentialExpiresAt(null);
    setUser(null);
    setDisplayInfo(null);
    writeSessionDisplay(null);
    setStatus("anonymous");
    setForceUpdateToken((token) => token + 1);
    const pending = pendingRef.current;
    if (pending) {
      pendingRef.current = null;
      pending.reject(new AuthRequiredError("로그아웃됐어."));
    }
  }, [betterAuthMode]);

  const requireValidCredential = useCallback(async (): Promise<string> => {
    if (betterAuthMode) {
      const session = await getBetterAuthSession();
      if (session && user) return "";
      setUser(null);
      setCredentialExpiresAt(null);
      setStatus("reauthRequired");
      await loginWithGoogleButton();
      return "";
    }
    const current = credentialRef.current;
    if (current && !isJwtExpired(current)) {
      return current;
    }
    if (current) {
      clearCredential();
    }
    if (!clientId) {
      setStatus("reauthRequired");
      setForceUpdateToken((token) => token + 1);
      throw new AuthRequiredError("Google 로그인이 설정되지 않았어.");
    }
    setStatus("reauthRequired");
    setForceUpdateToken((token) => token + 1);
    if (pendingRef.current) {
      return new Promise<string>((resolve, reject) => {
        const existing = pendingRef.current;
        if (existing) {
          existing.resolve = (value) => {
            pendingRef.current = null;
            resolve(value);
          };
          existing.reject = (error) => {
            pendingRef.current = null;
            reject(error);
          };
          return;
        }
        pendingRef.current = { resolve, reject };
      });
    }
    return new Promise<string>((resolve, reject) => {
      pendingRef.current = { resolve, reject };
      loginWithGoogleButton().catch((error) => {
        const pending = pendingRef.current;
        if (pending) {
          pendingRef.current = null;
          pending.reject(error instanceof Error ? error : new AuthRequiredError());
        }
      });
    });
  }, [betterAuthMode, clientId, clearCredential, loginWithGoogleButton, user]);

  // Initial status: if we have a display name from a previous session, mark
  // reauthRequired (we do NOT trust the previous credential). Otherwise the
  // user is anonymous.
  useEffect(() => {
    if (status === "unknown") {
      setStatus(displayInfo ? "reauthRequired" : "anonymous");
    }
  }, [status, displayInfo]);

  useEffect(() => {
    if (!betterAuthMode) return;
    let cancelled = false;
    setStatus("authenticating");
    getBetterAuthSession()
      .then(async (session) => {
        if (cancelled) return;
        if (!session) {
          setStatus("anonymous");
          return;
        }
        const expiresAt = typeof session.session.expiresAt === "number"
          ? session.session.expiresAt
          : new Date(session.session.expiresAt).getTime();
        const next: AuthUser = {
          email: session.user.email,
          displayName: session.user.name,
          role: session.user.role,
          expiresAt
        };
        setUser(next);
        setDisplayInfo({ email: next.email, displayName: next.displayName });
        writeSessionDisplay({ email: next.email, displayName: next.displayName });
        setCredentialExpiresAt(expiresAt);
        setStatus("authenticated");
      })
      .catch(() => {
        if (!cancelled) setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, [betterAuthMode]);

  // Best-effort GIS init so the prompt() helper is available app-wide.
  useEffect(() => {
    if (!clientId || gisInitRef.current) return;
    gisInitRef.current = true;
    loadGoogleIdentityScript().catch(() => undefined);
  }, [clientId]);

  // Periodic credential expiry check (1h Google ID token, 60s poll is fine).
  useEffect(() => {
    if (!credentialExpiresAt) return;
    const handle = window.setInterval(() => {
      if (credentialRef.current && isJwtExpired(credentialRef.current)) {
        clearCredential();
      }
    }, 60_000);
    return () => window.clearInterval(handle);
  }, [credentialExpiresAt, clearCredential]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      credentialExpiresAt,
      displayInfo,
      loginWithCredential,
      loginWithGoogleButton,
      signOut,
      requireValidCredential,
      forceUpdateToken
    }),
    [status, user, credentialExpiresAt, displayInfo, loginWithCredential, loginWithGoogleButton, signOut, requireValidCredential, forceUpdateToken]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );

}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
