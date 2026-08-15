export interface BrowserSession {
  user: { id: string; email: string; name: string; role: "allowed" };
  session: { id: string; expiresAt: string | number | Date };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Browser authentication is same-origin and cookie-based. */
export async function getBrowserSession(): Promise<BrowserSession | null> {
  const response = await fetch("/api/session", { credentials: "include" });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("인증 세션을 확인하지 못했어요.");
  const payload = await readJson(response) as { data?: BrowserSession } | null;
  return payload?.data ?? null;
}

export async function signInWithGoogle(): Promise<void> {
  const response = await fetch("/api/auth/sign-in/social", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: window.location.href })
  });
  const payload = await readJson(response) as { url?: string; data?: { url?: string }; error?: { message?: string } } | null;
  const target = payload?.url ?? payload?.data?.url;
  if (!response.ok || !target) throw new Error(payload?.error?.message || "Google 로그인 주소를 만들지 못했어요.");
  window.location.assign(target);
}

export async function signOutBrowser(): Promise<void> {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
}
