export interface BetterAuthSession {
  user: { id: string; email: string; name: string; role: "owner" | "editor" };
  session: { id: string; expiresAt: string | number | Date };
}

const authBaseUrl = String(import.meta.env.VITE_AUTH_BASE_URL || "").replace(/\/$/, "");

export function betterAuthConfigured(): boolean {
  return (import.meta.env.VITE_AUTH_ENABLED ?? "false") === "true" && Boolean(authBaseUrl);
}

function authUrl(path: string): string {
  if (!authBaseUrl) throw new Error("VITE_AUTH_BASE_URL이 설정되지 않았어.");
  return `${authBaseUrl}${path}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function getBetterAuthSession(): Promise<BetterAuthSession | null> {
  if (!betterAuthConfigured()) return null;
  const response = await fetch(authUrl("/api/session"), { credentials: "include" });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("인증 세션을 확인하지 못했어.");
  const payload = await readJson(response) as { data?: BetterAuthSession } | null;
  return payload?.data ?? null;
}

export async function signInWithGoogle(): Promise<void> {
  if (!betterAuthConfigured()) throw new Error("Better Auth가 설정되지 않았어.");
  const response = await fetch(authUrl("/api/auth/sign-in/social"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "google",
      callbackURL: window.location.href
    })
  });
  const payload = await readJson(response) as { url?: string; data?: { url?: string }; error?: { message?: string } } | null;
  const target = payload?.url ?? payload?.data?.url;
  if (!response.ok || !target) throw new Error(payload?.error?.message || "Google 로그인 주소를 만들지 못했어.");
  window.location.assign(target);
}

/** Exchange a GIS ID token at Better Auth without storing the token in the browser. */
export async function signInWithGoogleIdToken(token: string): Promise<void> {
  if (!betterAuthConfigured()) throw new Error("Better Auth가 설정되지 않았어.");
  const response = await fetch(authUrl("/api/auth/sign-in/social"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", idToken: { token } })
  });
  const payload = await readJson(response) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.message || "Google 로그인에 실패했어.");
}

export function signOutBetterAuth(): void {
  if (!betterAuthConfigured()) return;
  void fetch(authUrl("/api/auth/sign-out"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
}

export function betterAuthApiUrl(action: string): string {
  return authUrl(`/api/browser/${encodeURIComponent(action)}`);
}
