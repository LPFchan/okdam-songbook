import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth, AuthRequiredError, type AuthContextValue } from "../lib/auth/AuthContext";
import { isApiAuthError } from "../lib/api";

const mockFetch = vi.fn();

function App({ captureAuth }: { captureAuth?: (auth: AuthContextValue) => void }) {
  const auth = useAuth();
  if (captureAuth) captureAuth(auth);
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="user">{auth.user ? auth.user.displayName : ""}</span>
      <button type="button" onClick={() => auth.requireValidCredential().catch(() => undefined)}>require</button>
      <button type="button" onClick={() => auth.signOut()}>signout</button>
    </div>
  );
}

function renderApp(captureAuth?: (auth: AuthContextValue) => void) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<App captureAuth={captureAuth} />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("AuthProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    window.sessionStorage.clear();
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts as reauthRequired when a display name is persisted", async () => {
    window.sessionStorage.setItem("songbook:display-user", JSON.stringify({ email: "marie@example.com", displayName: "마리" }));
    renderApp();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("reauthRequired"));
    expect(screen.getByTestId("user").textContent).toBe("");
  });

  it("loads the authenticated user from the same-origin session", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, data: { email: "marie@example.com", displayName: "마리", role: "owner" } })
    });
    let captured: AuthContextValue | null = null;
    renderApp((auth) => {
      captured = auth;
    });
    await act(async () => {
      await captured!.requireValidCredential();
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    expect(screen.getByTestId("user").textContent).toBe("마리");
  });

  it("redirects to Google when the session is missing", async () => {
    mockFetch.mockImplementation((input: string | URL | Request) => {
      if (String(input).includes("/api/auth/sign-in/social")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ url: "/api/auth/callback/google" })
        });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ ok: false, error: { code: "UNAUTHORIZED", message: "로그인이 필요해." } })
      });
    });
    let captured: AuthContextValue | null = null;
    renderApp((auth) => {
      captured = auth;
    });
    await act(async () => {
      try {
        await captured!.requireValidCredential();
      } catch {
        /* expected */
      }
    });
    expect(mockFetch).toHaveBeenCalledWith("/api/auth/sign-in/social", expect.objectContaining({ method: "POST" }));
    expect(screen.getByTestId("status").textContent).toBe("authenticating");
  });

  it("returns to reauthRequired when the server session is unauthorized", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: { code: "UNAUTHORIZED", message: "로그인이 필요해." } })
    });
    let captured: AuthContextValue | null = null;
    renderApp((auth) => {
      captured = auth;
    });
    await act(async () => { await captured!.requireValidCredential().catch(() => undefined); });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("reauthRequired"));
  });

  it("exposes AuthRequiredError for callers that miss a credential", async () => {
    let captured: AuthContextValue | null = null;
    renderApp((auth) => {
      captured = auth;
    });
    let thrown: unknown = null;
    await act(async () => { await captured!.requireValidCredential().catch((err) => { thrown = err; }); });
    expect(thrown).toBeInstanceOf(AuthRequiredError);
  });

  it("signOut clears the credential and display info", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, data: { email: "marie@example.com", displayName: "마리", role: "owner" } })
    });
    let captured: AuthContextValue | null = null;
    renderApp((auth) => {
      captured = auth;
    });
    await act(async () => {
      await captured!.requireValidCredential();
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    await act(async () => {
      await captured!.signOut();
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("anonymous"));
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
