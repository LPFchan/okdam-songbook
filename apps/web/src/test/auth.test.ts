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
  const responseFor = (subject: string, displayName = subject) => ({
    ok: true,
    json: () => Promise.resolve({ ok: true, data: { subject, email: "user@example.com", displayName, role: "allowed" } })
  });

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
      json: () => Promise.resolve({ ok: true, data: { subject: "auth.lost.plus:42", email: "allowed@example.com", displayName: "마리", role: "allowed" } })
    });
    await auth.requireValidCredential();
    expect(auth.status).toBe("authenticated");
    expect(auth.user?.displayName).toBe("마리");
  });

  it("revalidates and rejects a queued action after the shared session changes account", async () => {
    auth.user = { subject: "auth.lost.plus:42", email: "reused@example.com", displayName: "Old", role: "allowed", expiresAt: null };
    auth.status = "authenticated";
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, data: { subject: "auth.lost.plus:99", email: "reused@example.com", displayName: "New", role: "allowed" } })
    });

    await expect(auth.requireValidCredential("auth.lost.plus:42")).rejects.toBeInstanceOf(AuthRequiredError);
    expect(auth.user?.subject).toBe("auth.lost.plus:99");
    expect(auth.status).toBe("reauthRequired");
  });

  it("keeps a queued owner valid when only that account's email changes", async () => {
    auth.user = { subject: "auth.lost.plus:42", email: "old@example.com", displayName: "User", role: "allowed", expiresAt: null };
    auth.status = "authenticated";
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, data: { subject: "auth.lost.plus:42", email: "new@example.com", displayName: "User", role: "allowed" } })
    });

    const updateToken = auth.forceUpdateToken;
    await expect(auth.requireValidCredential("auth.lost.plus:42")).resolves.toMatchObject({ email: "new@example.com" });
    expect(auth.status).toBe("authenticated");
    expect(auth.forceUpdateToken).toBe(updateToken);
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
      json: () => Promise.resolve({ ok: true, data: { subject: "auth.lost.plus:42", email: "allowed@example.com", displayName: "마리", role: "allowed" } })
    });
    await auth.requireValidCredential();
    expect(auth.status).toBe("authenticated");
    auth.signOut();
    expect(auth.status).toBe("anonymous");
    expect(window.sessionStorage.getItem("songbook:display-user")).toBeNull();
  });

  it("does not let an older refresh overwrite a newer account", async () => {
    let resolveOlder!: (value: ReturnType<typeof responseFor>) => void;
    mockFetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockResolvedValueOnce(responseFor("auth.lost.plus:b", "B"));

    const older = auth.refreshUser();
    await expect(auth.revalidateUser()).resolves.toMatchObject({ subject: "auth.lost.plus:b" });
    resolveOlder(responseFor("auth.lost.plus:a", "A"));

    await expect(older).resolves.toBeNull();
    expect(auth.user?.subject).toBe("auth.lost.plus:b");
  });

  it("does not restore a session from a refresh started before sign-out", async () => {
    let resolveRefresh!: (value: ReturnType<typeof responseFor>) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));

    const refresh = auth.refreshUser();
    auth.signOut();
    resolveRefresh(responseFor("auth.lost.plus:a", "A"));

    await expect(refresh).resolves.toBeNull();
    expect(auth.user).toBeNull();
    expect(auth.status).toBe("anonymous");
  });

  it("ignores an older refresh failure after a newer account succeeds", async () => {
    let rejectOlder!: (reason: Error) => void;
    mockFetch
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOlder = reject; }))
      .mockResolvedValueOnce(responseFor("auth.lost.plus:b", "B"));

    const older = auth.refreshUser();
    await auth.revalidateUser();
    rejectOlder(new Error("stale network failure"));

    await expect(older).resolves.toBeNull();
    expect(auth.user?.subject).toBe("auth.lost.plus:b");
    expect(auth.status).toBe("authenticated");
  });

  it("does not validate an action from a superseded subject refresh", async () => {
    auth.user = { subject: "auth.lost.plus:a", email: "a@example.com", displayName: "A", role: "allowed", expiresAt: null };
    auth.status = "authenticated";
    let resolveOlder!: (value: ReturnType<typeof responseFor>) => void;
    mockFetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockResolvedValueOnce(responseFor("auth.lost.plus:b", "B"));

    const actionCredential = auth.requireValidCredential("auth.lost.plus:a");
    await auth.revalidateUser();
    resolveOlder(responseFor("auth.lost.plus:a", "A"));

    await expect(actionCredential).rejects.toBeInstanceOf(AuthRequiredError);
    expect(auth.user?.subject).toBe("auth.lost.plus:b");
  });

  it("joins concurrent validations for the same account", async () => {
    auth.user = { subject: "auth.lost.plus:a", email: "a@example.com", displayName: "A", role: "allowed", expiresAt: null };
    auth.status = "authenticated";
    let resolveRefresh!: (value: ReturnType<typeof responseFor>) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));

    const favoriteCredential = auth.requireValidCredential("auth.lost.plus:a");
    const queueCredential = auth.requireValidCredential("auth.lost.plus:a");
    resolveRefresh(responseFor("auth.lost.plus:a", "A"));

    await expect(favoriteCredential).resolves.toMatchObject({ subject: "auth.lost.plus:a" });
    await expect(queueCredential).resolves.toMatchObject({ subject: "auth.lost.plus:a" });
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(auth.status).toBe("authenticated");
  });

  it("hides the previous account while revalidating an externally changed session", async () => {
    auth.user = { subject: "auth.lost.plus:a", email: "a@example.com", displayName: "A", role: "allowed", expiresAt: null };
    auth.status = "authenticated";
    let resolveRefresh!: (value: ReturnType<typeof responseFor>) => void;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));

    const refresh = auth.revalidateUser();
    expect(auth.user).toBeNull();
    expect(auth.status).toBe("unknown");
    resolveRefresh(responseFor("auth.lost.plus:b", "B"));

    await expect(refresh).resolves.toMatchObject({ subject: "auth.lost.plus:b" });
    expect(auth.user?.subject).toBe("auth.lost.plus:b");
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
