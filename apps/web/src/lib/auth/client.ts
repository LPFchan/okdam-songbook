const COMMON_AUTH_ORIGIN = "https://auth.lost.plus";

export function signInWithCommonAuth(): void {
  const target = new URL("/login", COMMON_AUTH_ORIGIN);
  target.searchParams.set("to", window.location.href);
  window.location.assign(target.toString());
}

export async function signOutBrowser(): Promise<void> {
  await fetch("/api/logout", {
    method: "POST",
    credentials: "include"
  });
}
