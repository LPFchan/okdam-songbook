import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { __internals } from "../src/index";
import { CodeStore } from "../src/store";
import { generateAuthorizationCode, mintAccessToken, signStateCookie, verifyAccessToken } from "../src/oauth";
import { generateState } from "@songbook/shared";

const env = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-secret",
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/TEST/exec",
  INTERNAL_PROXY_SECRET: "internal-test-secret",
  GPT_OAUTH_CLIENT_ID: "gpt-client-id-1234",
  GPT_OAUTH_CLIENT_SECRET: "gpt-client-secret-5678",
  MARIE_EMAIL: "marie@example.com",
  SEONGWOOK_EMAIL: "seongwook@example.com",
  YEOWOOL_EMAIL: "yeowool@example.com",
  COOKIE_SECRET: "cookie-test-secret-1234",
  SESSION_TTL_SECONDS: "3600",
  CALLBACK_BASE_URL: "https://chatgpt-proxy.example.com",
  CHATGPT_REDIRECT_URI_ALLOWLIST: "https://chatgpt.com/aip/g-123/oauth/callback,https://chat.openai.com/aip/g-123/oauth/callback",
  CODE_STORE_TTL_MS: "300000",
  REFRESH_TOKEN_TTL_SECONDS: "2592000"
};

const GPT_REDIRECT = "https://chatgpt.com/aip/g-123/oauth/callback";

const fakeD1 = {
  prepare() {
    const statement = {
      bind() {
        return statement;
      },
      async all() {
        return { results: [], meta: { changes: 0 } };
      },
      async first() {
        return null;
      },
      async run() {
        return { meta: { changes: 0 } };
      }
    };
    return statement;
  },
  async batch() {
    return [];
  },
  async exec() {
    return { count: 0, duration: 0 };
  }
} as never;

type RequestInit = globalThis.RequestInit;

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFetchMock(): { fetchMock: ReturnType<typeof vi.fn>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init || {} });
    return new Response(JSON.stringify({ ok: true, data: { forwarded: true }, error: null, requestId: "r", serverTime: "t" }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { fetchMock, calls };
}

function buildCookieHeader(parts: Array<[string, string]>): string {
  return parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
}

async function signStateFor(state: string, redirectUri: string): Promise<string> {
  const token = await signStateCookie(
    { state, gptRedirectUri: redirectUri, returnTo: "gpt-state" },
    { cookieSecret: env.COOKIE_SECRET, ttlSeconds: 600 }
  );
  return token;
}

let fetchMock: ReturnType<typeof vi.fn>;
let calls: FetchCall[];
let codeStore: CodeStore;

beforeEach(() => {
  const setup = createFetchMock();
  fetchMock = setup.fetchMock;
  calls = setup.calls;
  vi.stubGlobal("fetch", fetchMock);
  codeStore = new CodeStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function postToken(body: URLSearchParams): Promise<Response> {
  return worker.fetch(
    new Request("https://chatgpt-proxy.example.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    }),
    env,
    { codeStore }
  );
}

function postApi(action: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(
    new Request(`https://chatgpt-proxy.example.com/api/${action}`, { method: "POST", ...init }),
    env
  );
}

describe("routing", () => {
  it("404 on unknown routes", async () => {
    const response = await worker.fetch(new Request("https://chatgpt-proxy.example.com/nope"), env);
    expect(response.status).toBe(404);
  });

  it("does not accept POST on /oauth/callback", async () => {
    const response = await worker.fetch(new Request("https://chatgpt-proxy.example.com/oauth/callback", { method: "POST", body: "" }), env);
    expect(response.status).toBe(404);
  });

  it("keeps Better Auth routes opt-in", async () => {
    const response = await worker.fetch(new Request("https://chatgpt-proxy.example.com/api/auth/get-session"), env);
    expect(response.status).toBe(404);
  });

  it("rejects an anonymous browser gateway call when Better Auth is enabled", async () => {
    const response = await worker.fetch(
      new Request("https://chatgpt-proxy.example.com/api/browser/createPerformance", {
        method: "POST",
        headers: { Origin: "https://devuterian.github.io", "Content-Type": "application/json" },
        body: JSON.stringify({ songId: "song-1" })
      }),
      { ...env, BETTER_AUTH_ENABLED: "true", AUTH_DB: fakeD1, BETTER_AUTH_URL: "https://chatgpt-proxy.example.com", BETTER_AUTH_SECRET: "test-better-auth-secret", AUTH_TRUSTED_ORIGINS: "https://devuterian.github.io" }
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://devuterian.github.io");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("admits credentialed browser gateway preflight only for a trusted origin", async () => {
    const authEnv = { ...env, BETTER_AUTH_ENABLED: "true", AUTH_DB: fakeD1, BETTER_AUTH_URL: "https://chatgpt-proxy.example.com", BETTER_AUTH_SECRET: "test-better-auth-secret", AUTH_TRUSTED_ORIGINS: "https://devuterian.github.io" };
    const allowed = await worker.fetch(new Request("https://chatgpt-proxy.example.com/api/browser/createPerformance", {
      method: "OPTIONS", headers: { Origin: "https://devuterian.github.io" }
    }), authEnv);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://devuterian.github.io");
    const denied = await worker.fetch(new Request("https://chatgpt-proxy.example.com/api/browser/createPerformance", {
      method: "OPTIONS", headers: { Origin: "https://evil.example" }
    }), authEnv);
    expect(denied.status).toBe(204);
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("keeps TJ browser actions behind the Better Auth gateway allowlist", async () => {
    const authEnv = { ...env, BETTER_AUTH_ENABLED: "true", AUTH_DB: fakeD1, BETTER_AUTH_URL: "https://chatgpt-proxy.example.com", BETTER_AUTH_SECRET: "test-better-auth-secret", AUTH_TRUSTED_ORIGINS: "https://devuterian.github.io" };
    for (const action of ["lookupTjSong", "searchTjSongs", "addTjSong", "restoreSong"]) {
      const response = await worker.fetch(new Request(`https://chatgpt-proxy.example.com/api/browser/${action}`, {
        method: "POST",
        headers: { Origin: "https://devuterian.github.io", "Content-Type": "application/json" },
        body: "{}"
      }), authEnv);
      expect(response.status).toBe(401);
    }
  });

  it("derives the browser actor from the Better Auth session user", () => {
    expect(__internals.browserActor({
      user: { id: "ba-user", email: "MARIE@example.com", name: "Marie", emailVerified: true },
      session: { id: "ba-session", userId: "ba-user", expiresAt: new Date(Date.now() + 60_000) }
    })).toEqual({
      actorId: "ba-user",
      actorEmail: "marie@example.com",
      actorName: "Marie",
      actorRole: "member",
      source: "browser-session"
    });
  });
});

describe("GET /authorize", () => {
  it("redirects to Google with state and sets state cookie", async () => {
    const u = new URL("https://chatgpt-proxy.example.com/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", env.GPT_OAUTH_CLIENT_ID);
    u.searchParams.set("redirect_uri", GPT_REDIRECT);
    u.searchParams.set("state", "gpt-state");
    u.searchParams.set("scope", "openid email profile");
    const response = await worker.fetch(new Request(u.toString()), env);
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") || "";
    expect(location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/);
    const parsed = new URL(location);
    expect(parsed.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(parsed.searchParams.get("scope")).toBe("openid email profile");
    expect(parsed.searchParams.get("state")).toBeTruthy();
    expect(response.headers.get("Set-Cookie") || "").toContain("songbook_chatgpt_state=");
  });

  it("rejects bad response_type", async () => {
    const u = new URL("https://chatgpt-proxy.example.com/authorize");
    u.searchParams.set("response_type", "token");
    u.searchParams.set("client_id", env.GPT_OAUTH_CLIENT_ID);
    u.searchParams.set("redirect_uri", GPT_REDIRECT);
    const response = await worker.fetch(new Request(u.toString()), env);
    expect(response.status).toBe(400);
  });

  it("rejects unknown client_id", async () => {
    const u = new URL("https://chatgpt-proxy.example.com/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", "wrong");
    u.searchParams.set("redirect_uri", GPT_REDIRECT);
    const response = await worker.fetch(new Request(u.toString()), env);
    expect(response.status).toBe(400);
  });

  it("rejects redirect_uri outside the allowlist", async () => {
    const u = new URL("https://chatgpt-proxy.example.com/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", env.GPT_OAUTH_CLIENT_ID);
    u.searchParams.set("redirect_uri", "https://attacker.example.com/cb");
    const response = await worker.fetch(new Request(u.toString()), env);
    expect(response.status).toBe(400);
  });

  it("rejects too-short PKCE challenge", async () => {
    const u = new URL("https://chatgpt-proxy.example.com/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", env.GPT_OAUTH_CLIENT_ID);
    u.searchParams.set("redirect_uri", GPT_REDIRECT);
    u.searchParams.set("code_challenge", "short");
    u.searchParams.set("code_challenge_method", "S256");
    const response = await worker.fetch(new Request(u.toString()), env);
    expect(response.status).toBe(400);
  });
});

describe("GET /oauth/callback", () => {
  it("rejects bad state", async () => {
    const cookie = await signStateFor("expected-state", GPT_REDIRECT);
    const url = new URL("https://chatgpt-proxy.example.com/oauth/callback");
    url.searchParams.set("code", "x");
    url.searchParams.set("state", "different-state");
    const request = new Request(url.toString(), {
      headers: { Cookie: buildCookieHeader([["songbook_chatgpt_state", cookie]]) }
    });
    const response = await worker.fetch(request, env, { codeStore });
    expect(response.status).toBe(400);
  });

  it("issues a worker code to the ChatGPT redirect URI on allowlisted user", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sub: "1", email: "MARIE@example.com", email_verified: "true", name: "Marie" }), { status: 200 })
    );
    const state = generateState();
    const cookie = await signStateFor(state, GPT_REDIRECT);
    const url = new URL("https://chatgpt-proxy.example.com/oauth/callback");
    url.searchParams.set("code", "google-auth-code");
    url.searchParams.set("state", state);
    const request = new Request(url.toString(), {
      headers: { Cookie: buildCookieHeader([["songbook_chatgpt_state", cookie]]) }
    });
    const response = await worker.fetch(request, env, { codeStore });
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") || "";
    const parsed = new URL(location);
    expect(parsed.origin + parsed.pathname).toBe(GPT_REDIRECT);
    expect(parsed.searchParams.get("code")).toBeTruthy();
    expect(parsed.searchParams.get("state")).toBe("gpt-state");
    // The minted code is also stored in the codeStore.
    const minted = parsed.searchParams.get("code") || "";
    expect(codeStore.peekCode(minted)).toBeTruthy();
  });

  it("returns 403 for non-allowlisted user", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ sub: "1", email: "stranger@example.com", email_verified: "true", name: "S" }), { status: 200 })
    );
    const state = generateState();
    const cookie = await signStateFor(state, GPT_REDIRECT);
    const url = new URL("https://chatgpt-proxy.example.com/oauth/callback");
    url.searchParams.set("code", "x");
    url.searchParams.set("state", state);
    const request = new Request(url.toString(), {
      headers: { Cookie: buildCookieHeader([["songbook_chatgpt_state", cookie]]) }
    });
    const response = await worker.fetch(request, env, { codeStore });
    expect(response.status).toBe(403);
  });
});

describe("POST /token", () => {
  it("rejects wrong client_id", async () => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "abc",
      redirect_uri: GPT_REDIRECT,
      client_id: "wrong",
      client_secret: env.GPT_OAUTH_CLIENT_SECRET
    });
    const response = await postToken(body);
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: string };
    expect(payload.error).toBe("invalid_client");
  });

  it("rejects wrong client_secret", async () => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "abc",
      redirect_uri: GPT_REDIRECT,
      client_id: env.GPT_OAUTH_CLIENT_ID,
      client_secret: "wrong"
    });
    const response = await postToken(body);
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: string };
    expect(payload.error).toBe("invalid_client");
  });

  it("exchanges an authorization code (no PKCE) for access + refresh tokens", async () => {
    const code = await generateAuthorizationCode();
    codeStore.storeCode(code, {
      sub: "user-sub",
      email: "marie@example.com",
      name: "Marie",
      redirectUri: GPT_REDIRECT,
      issuedAt: Date.now()
    }, 60_000);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: GPT_REDIRECT,
      client_id: env.GPT_OAUTH_CLIENT_ID,
      client_secret: env.GPT_OAUTH_CLIENT_SECRET
    });
    const response = await postToken(body);
    expect(response.status).toBe(200);
    const payload = await response.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
    expect(payload.access_token).toBeTruthy();
    expect(payload.refresh_token).toBeTruthy();
    expect(payload.token_type).toBe("bearer");
    expect(payload.expires_in).toBe(3600);
    expect(payload.scope).toBe("openid email profile");
    const claims = await verifyAccessToken(payload.access_token, env.COOKIE_SECRET);
    expect(claims).toMatchObject({ sub: "user-sub", email: "marie@example.com" });
  });

  it("rejects an authorization code that has already been used", async () => {
    const code = await generateAuthorizationCode();
    codeStore.storeCode(code, {
      sub: "user-sub",
      email: "marie@example.com",
      name: "Marie",
      redirectUri: GPT_REDIRECT,
      issuedAt: Date.now()
    }, 60_000);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: GPT_REDIRECT,
      client_id: env.GPT_OAUTH_CLIENT_ID,
      client_secret: env.GPT_OAUTH_CLIENT_SECRET
    });
    const first = await postToken(body);
    expect(first.status).toBe(200);
    const second = await postToken(body);
    expect(second.status).toBe(400);
    const payload = await second.json() as { error: string };
    expect(payload.error).toBe("invalid_grant");
  });

  it("rejects mismatched redirect_uri during code exchange", async () => {
    const code = await generateAuthorizationCode();
    codeStore.storeCode(code, {
      sub: "user-sub",
      email: "marie@example.com",
      name: "Marie",
      redirectUri: GPT_REDIRECT,
      issuedAt: Date.now()
    }, 60_000);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chatgpt.com/aip/other/oauth/callback",
      client_id: env.GPT_OAUTH_CLIENT_ID,
      client_secret: env.GPT_OAUTH_CLIENT_SECRET
    });
    const response = await postToken(body);
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: string };
    expect(payload.error).toBe("invalid_grant");
  });

  it("verifies PKCE S256 code_verifier on code exchange", async () => {
    const verifier = "verifier-with-enough-entropy-to-be-acceptable-1234567890";
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const code = await generateAuthorizationCode();
    codeStore.storeCode(code, {
      sub: "user-sub",
      email: "marie@example.com",
      name: "Marie",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      redirectUri: GPT_REDIRECT,
      issuedAt: Date.now()
    }, 60_000);
    const okForm = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: GPT_REDIRECT,
      client_id: env.GPT_OAUTH_CLIENT_ID,
      client_secret: env.GPT_OAUTH_CLIENT_SECRET,
      code_verifier: verifier
    });
    const okResponse = await postToken(okForm);
    expect(okResponse.status).toBe(200);

    const code2 = await generateAuthorizationCode();
    codeStore.storeCode(code2, {
      sub: "user-sub",
      email: "marie@example.com",
      name: "Marie",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      redirectUri: GPT_REDIRECT,
      issuedAt: Date.now()
    }, 60_000);
    const badForm = new URLSearchParams({
      grant_type: "authorization_code",
      code: code2,
      redirect_uri: GPT_REDIRECT,
      client_id: env.GPT_OAUTH_CLIENT_ID,
      client_secret: env.GPT_OAUTH_CLIENT_SECRET,
      code_verifier: "wrong-verifier-with-enough-entropy-1234567890abc"
    });
    const badResponse = await postToken(badForm);
    expect(badResponse.status).toBe(400);
  });

  it("rejects unknown grant_type", async () => {
    const body = new URLSearchParams({
      grant_type: "password",
      client_id: env.GPT_OAUTH_CLIENT_ID,
      client_secret: env.GPT_OAUTH_CLIENT_SECRET
    });
    const response = await postToken(body);
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: string };
    expect(payload.error).toBe("unsupported_grant_type");
  });

  it("exchanges a refresh token for a new access token", async () => {
    const code = await generateAuthorizationCode();
    codeStore.storeCode(code, {
      sub: "user-sub",
      email: "marie@example.com",
      name: "Marie",
      redirectUri: GPT_REDIRECT,
      issuedAt: Date.now()
    }, 60_000);
    const grant = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: GPT_REDIRECT,
      client_id: env.GPT_OAUTH_CLIENT_ID,
      client_secret: env.GPT_OAUTH_CLIENT_SECRET
    });
    const grantResponse = await postToken(grant);
    expect(grantResponse.status).toBe(200);
    const grantPayload = await grantResponse.json() as { refresh_token: string; access_token: string };
    expect(grantPayload.refresh_token).toBeTruthy();

    const refreshForm = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: grantPayload.refresh_token,
      client_id: env.GPT_OAUTH_CLIENT_ID,
      client_secret: env.GPT_OAUTH_CLIENT_SECRET
    });
    const refreshResponse = await postToken(refreshForm);
    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json() as { access_token: string; refresh_token: string; expires_in: number };
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(grantPayload.access_token);
    expect(refreshed.expires_in).toBe(3600);
  });
});

describe("POST /api/:action", () => {
  async function bearer(sub: string, email: string, name: string): Promise<string> {
    const session = await mintAccessToken({
      signingSecret: env.COOKIE_SECRET,
      sub,
      email,
      name,
      ttlSeconds: 3600,
      jti: "jti"
    });
    return session.token;
  }

  it("rejects requests without a Bearer token", async () => {
    const response = await postApi("gptSearchSongs", { body: "{}" });
    expect(response.status).toBe(401);
  });

  it("rejects a forged Bearer token", async () => {
    const token = await bearer("1", "marie@example.com", "Marie");
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const response = await postApi("gptSearchSongs", { body: "{}", headers: { Authorization: `Bearer ${tampered}` } });
    expect(response.status).toBe(401);
  });

  it("rejects an expired access token", async () => {
    const past = Date.now() - 5 * 60_000;
    const session = await mintAccessToken({
      signingSecret: env.COOKIE_SECRET,
      sub: "1",
      email: "marie@example.com",
      name: "Marie",
      ttlSeconds: 60,
      jti: "jti",
      nowMs: past
    });
    const response = await postApi("gptSearchSongs", { body: "{}", headers: { Authorization: `Bearer ${session.token}` } });
    expect(response.status).toBe(401);
  });

  it("rejects a token signed with a different secret", async () => {
    const session = await mintAccessToken({
      signingSecret: "other-secret",
      sub: "1",
      email: "marie@example.com",
      name: "Marie",
      ttlSeconds: 3600,
      jti: "jti"
    });
    const response = await postApi("gptSearchSongs", { body: "{}", headers: { Authorization: `Bearer ${session.token}` } });
    expect(response.status).toBe(401);
  });

  it("rejects non-allowlisted actions", async () => {
    const token = await bearer("1", "marie@example.com", "Marie");
    const response = await postApi("upsertSong", { body: "{}", headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(403);
  });

  it("rejects gptAddSong without confirmed=true", async () => {
    const token = await bearer("1", "marie@example.com", "Marie");
    const response = await postApi("gptAddSong", {
      body: JSON.stringify({ clientRequestId: "abc", title: "x", artist: "y" }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    expect(response.status).toBe(409);
  });

  it("rejects gptAddSong without clientRequestId", async () => {
    const token = await bearer("1", "marie@example.com", "Marie");
    const response = await postApi("gptAddSong", {
      body: JSON.stringify({ confirmed: true, title: "x", artist: "y" }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    expect(response.status).toBe(400);
  });

  it("forwards gptSearchSongs to Apps Script with auth headers and body", async () => {
    const token = await bearer("user-sub", "marie@example.com", "마리");
    const response = await postApi("gptSearchSongs", {
      body: JSON.stringify({ query: "포니" }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    expect(response.status).toBe(200);
    expect(calls.length).toBe(1);
    const call = calls[0];
    const url = new URL(call.url);
    expect(url.searchParams.get("action")).toBe("gptSearchSongs");
    expect(call.init.headers && (call.init.headers as Record<string, string>)["X-Internal-Proxy-Secret"]).toBe(env.INTERNAL_PROXY_SECRET);
    expect(call.init.headers && (call.init.headers as Record<string, string>)["X-ChatGpt-Actor-Email"]).toBe("marie@example.com");
    expect(call.init.headers && (call.init.headers as Record<string, string>)["X-ChatGpt-Actor-Role"]).toBe("member");
    expect(call.init.headers && (call.init.headers as Record<string, string>)["X-ChatGpt-Source"]).toBe("chatgpt-action");
    const body = JSON.parse(call.init.body as string) as { query: string };
    expect(body.query).toBe("포니");
  });

  it("rejects a token whose email is no longer in the allowlist", async () => {
    const token = await bearer("1", "intruder@example.com", "Intruder");
    const response = await postApi("gptSearchSongs", {
      body: JSON.stringify({ query: "x" }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    expect(response.status).toBe(403);
  });
});

describe("CodeStore", () => {
  it("expunges used codes on takeCode", () => {
    const store = new CodeStore();
    store.storeCode("a", { sub: "s", email: "e@x.com", name: "n", redirectUri: "https://x", issuedAt: 0 }, 60_000);
    expect(store.takeCode("a")).toBeTruthy();
    expect(store.takeCode("a")).toBeNull();
  });

  it("rotates refresh tokens", () => {
    const store = new CodeStore();
    store.storeRefreshToken("old", { sub: "s", email: "e@x.com", name: "n", issuedAt: 0 }, 60);
    expect(store.takeRefreshToken("old")).toBeTruthy();
    expect(store.takeRefreshToken("old")).toBeNull();
    store.rotateRefreshToken("never-set", "new", { sub: "s", email: "e@x.com", name: "n", issuedAt: 0 }, 60);
    expect(store.takeRefreshToken("new")).toBeTruthy();
  });
});
