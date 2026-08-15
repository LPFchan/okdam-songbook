import { fetchCurrentUser, isApiAuthError, mockMode } from "./api";
import { signInWithGoogle, signOutBrowser } from "./auth/client";

export type AuthStatus = "unknown" | "anonymous" | "authenticating" | "authenticated" | "reauthRequired";

export interface AuthUser {
  email: string;
  displayName: string;
  role: "allowed";
  expiresAt: number | null;
}

const SESSION_KEY = "songbook:display-user";

export class AuthRequiredError extends Error {
  readonly code = "AUTH_REQUIRED";
  constructor(message = "기록하려면 Google 로그인이 필요해요.") {
    super(message);
    this.name = "AuthRequiredError";
  }
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

class AuthStore {
  status = $state<AuthStatus>("unknown");
  user = $state<AuthUser | null>(null);
  displayInfo = $state<{ email: string; displayName: string } | null>(readSessionDisplay());
  forceUpdateToken = $state(0);

  private adoptServerUser(current: { email: string; displayName: string; role: "allowed" }): AuthUser {
    const next: AuthUser = { ...current, expiresAt: null };
    this.user = next;
    this.displayInfo = { email: next.email, displayName: next.displayName };
    writeSessionDisplay({ email: next.email, displayName: next.displayName });
    this.status = "authenticated";
    this.forceUpdateToken += 1;
    return next;
  }

  async refreshUser(): Promise<AuthUser | null> {
    try {
      return this.adoptServerUser(await fetchCurrentUser());
    } catch {
      this.user = null;
      this.status = "anonymous";
      return null;
    }
  }

  async loginWithGoogleButton(): Promise<AuthUser> {
    if (mockMode()) {
      return this.adoptServerUser({ email: "allowed@example.com", displayName: "마리", role: "allowed" });
    }
    this.status = "authenticating";
    try {
      await signInWithGoogle();
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      this.status = "reauthRequired";
      const message = error instanceof Error && error.message ? error.message : "Google 로그인을 시작하지 못했어요.";
      throw new AuthRequiredError(message);
    }
    throw new AuthRequiredError("Google 로그인 화면으로 이동했어요.");
  }

  signOut() {
    if (!mockMode()) void signOutBrowser();
    this.user = null;
    this.displayInfo = null;
    writeSessionDisplay(null);
    this.status = "anonymous";
    this.forceUpdateToken += 1;
  }

  async requireValidCredential(): Promise<void> {
    if (this.user) return;
    const current = await this.refreshUser();
    if (current) return;
    this.status = "reauthRequired";
    await this.loginWithGoogleButton();
  }

  /** Called once on app start to resolve the initial session. */
  async initialize() {
    if (this.status !== "unknown") return;
    const current = await this.refreshUser();
    if (!current && this.displayInfo) this.status = "reauthRequired";
  }
}

export const auth = new AuthStore();

export function handleAuthErrorMessage(error: unknown): string | null {
  if (error instanceof AuthRequiredError) return error.message;
  if (isApiAuthError(error)) return "로그인이 만료됐어요. 다시 로그인해주세요.";
  return null;
}
