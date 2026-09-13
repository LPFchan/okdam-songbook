import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../lib/auth/client", () => ({ signInWithCommonAuth: vi.fn(), signOutBrowser: vi.fn() }));
import { auth, AuthRequiredError } from "../lib/auth.svelte";
import { isApiAuthError } from "../lib/api";
import { signInWithCommonAuth } from "../lib/auth/client";

const mockFetch = vi.fn();

async function resetAuth() {
  auth.user = null;
  auth.displayInfo = null;
  auth.forceUpdateToken = 0;
  window.sessionStorage.clear();
  // Fresh anonymous baseline; initialize() only runs once per status.
  auth.status = "anonymous";
}

describe("auth store", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    vi.mocked(signInWithCommonAuth).mockClear();
    await resetAuth();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await resetAuth();
  });

  it("loads the authenticated user from the same-origin session", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, data: { email: "allowed@example.com", displayName: "마리", role: "allowed" } })
    });
    await auth.requireValidCredential();
    expect(auth.status).toBe("authenticated");
    expect(auth.user?.displayName).toBe("마리");
  });

  it("redirects to common auth when the session is missing", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ ok: false, error: { code: "UNAUTHORIZED", message: "로그인이 필요해." } })
    });
    await auth.requireValidCredential().catch(() => undefined);
    expect(signInWithCommonAuth).toHaveBeenCalledOnce();
  });

  it("enters authenticating while redirecting after the server session is unauthorized", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: { code: "UNAUTHORIZED", message: "로그인이 필요해." } })
    });
    await auth.requireValidCredential().catch(() => undefined);
    expect(auth.status).toBe("authenticating");
  });

  it("exposes AuthRequiredError for callers that miss a credential", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: { code: "UNAUTHORIZED", message: "로그인이 필요해." } })
    });
    let thrown: unknown = null;
    await auth.requireValidCredential().catch((error) => {
      thrown = error;
    });
    expect(thrown).toBeInstanceOf(AuthRequiredError);
  });

  it("signOut clears the credential and display info", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, data: { email: "allowed@example.com", displayName: "마리", role: "allowed" } })
    });
    await auth.requireValidCredential();
    expect(auth.status).toBe("authenticated");
    auth.signOut();
    expect(auth.status).toBe("anonymous");
    expect(window.sessionStorage.getItem("songbook:display-user")).toBeNull();
  });

  it("isApiAuthError detects UNAUTHORIZED codes", () => {
    const err = new Error("x") as Error & { code?: string };
    err.code = "UNAUTHORIZED";
    expect(isApiAuthError(err)).toBe(true);
    const err2 = new Error("x") as Error & { code?: string };
    err2.code = "FORBIDDEN";
    expect(isApiAuthError(err2)).toBe(true);
    const err3 = new Error("x") as Error & { code?: string };
    err3.code = "INTERNAL_ERROR";
    expect(isApiAuthError(err3)).toBe(false);
    expect(isApiAuthError("UNAUTHORIZED")).toBe(false);
    expect(isApiAuthError(null)).toBe(false);
  });
});
