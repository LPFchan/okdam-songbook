import { describe, expect, it, vi } from "vitest";
import { createCommonAuthClient, createMcpAuthAdapter } from "../src/auth.js";

const identity = {
  email: " Allowed@Example.COM ",
  name: "마리",
  role: "user" as const,
  services: ["okdam"]
};

describe("auth.lost.plus client", () => {
  it("forwards cookie and bearer credentials verbatim and resolves the shared identity", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: globalThis.RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Cookie")).toBe("lp_auth=session-value; theme=dark");
      expect(headers.get("Authorization")).toBe("Bearer token-value");
      return Response.json(identity);
    });
    const auth = createCommonAuthClient({ origin: "https://auth.lost.plus/", serviceKey: "okdam", fetch: fetch as typeof globalThis.fetch });
    const resolved = await auth.resolve(new Request("https://okdam.lost.plus/api/me", { headers: { Cookie: "lp_auth=session-value; theme=dark", Authorization: "Bearer token-value" } }));
    expect(fetch).toHaveBeenCalledWith("https://auth.lost.plus/api/whoami", expect.objectContaining({ method: "GET" }));
    expect(resolved).toEqual({ ...identity, email: "allowed@example.com" });
  });

  it("accepts globally visible accounts and rejects accounts excluded from okdam", async () => {
    const visible = createCommonAuthClient({
      origin: "https://auth.lost.plus",
      serviceKey: "okdam",
      fetch: async () => Response.json({ ...identity, services: [] })
    });
    expect(await visible.resolve(new Request("https://okdam.lost.plus/api/me"))).not.toBeNull();

    const excluded = createCommonAuthClient({
      origin: "https://auth.lost.plus",
      serviceKey: "okdam",
      fetch: async () => Response.json({ ...identity, services: ["chat"] })
    });
    expect(await excluded.resolve(new Request("https://okdam.lost.plus/api/me"))).toBeNull();
  });

  it("fails closed on rejection, malformed identity, or an unavailable auth service", async () => {
    for (const fetch of [
      async () => new Response(null, { status: 401 }),
      async () => Response.json({ email: "not-an-email" }),
      async () => { throw new Error("offline"); }
    ]) {
      const auth = createCommonAuthClient({ origin: "https://auth.lost.plus", serviceKey: "okdam", fetch });
      expect(await auth.resolve(new Request("https://okdam.lost.plus/api/me"))).toBeNull();
    }
  });

  it("forwards logout and preserves the shared cookie deletion response", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: globalThis.RequestInit) => {
      expect(new Headers(init?.headers).get("Cookie")).toBe("lp_auth=session-value");
      return new Response(null, { status: 204, headers: { "Set-Cookie": "lp_auth=; Domain=.lost.plus; Max-Age=0; Path=/" } });
    });
    const auth = createCommonAuthClient({ origin: "https://auth.lost.plus", serviceKey: "okdam", fetch: fetch as typeof globalThis.fetch });
    const response = await auth.logout(new Request("https://okdam.lost.plus/api/logout", { headers: { Cookie: "lp_auth=session-value" } }));
    expect(fetch).toHaveBeenCalledWith("https://auth.lost.plus/api/logout", expect.objectContaining({ method: "POST" }));
    expect(response.headers.get("Set-Cookie")).toContain("Domain=.lost.plus");
  });
});

describe("MCP shared bearer validation", () => {
  it("uses common-auth identity and grants Songbook's equal read/write permissions", async () => {
    const auth = createCommonAuthClient({ origin: "https://auth.lost.plus", serviceKey: "okdam", fetch: async () => Response.json(identity) });
    const result = await createMcpAuthAdapter(auth).verifyRequest(new Request("https://okdam.lost.plus/mcp", { headers: { Authorization: "Bearer shared-token" } }), ["songbook:write"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toEqual({ accessToken: "shared-token", scopes: ["songbook:read", "songbook:write"] });
      expect(result.principal).toEqual({ userId: "allowed@example.com", actor: { email: "allowed@example.com", displayName: "마리" } });
    }
  });

  it("returns an invalid-token challenge when common auth rejects the bearer", async () => {
    const auth = createCommonAuthClient({ origin: "https://auth.lost.plus", serviceKey: "okdam", fetch: async () => new Response(null, { status: 401 }) });
    const result = await createMcpAuthAdapter(auth).verifyRequest(new Request("https://okdam.lost.plus/mcp", { headers: { Authorization: "Bearer revoked" } }), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });
});
