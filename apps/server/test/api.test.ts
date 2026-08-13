import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type SongbookDatabase } from "@songbook/server-core";
import { createServerApp } from "../src/api.js";
import { createAllowlistRoleResolver, createMcpAuthAdapter } from "../src/auth.js";

const origin = "https://songbook.example";
let database: SongbookDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function app(options: Partial<Parameters<typeof createServerApp>[0]> = {}) {
  database = openDatabase();
  return createServerApp({ database, origin, ...options } as Parameters<typeof createServerApp>[0]).app;
}

function request(path: string, init: globalThis.RequestInit = {}) {
  return new Request(`${origin}${path}`, init);
}

describe("same-origin server surface", () => {
  it("resolves configured owner/editor roles and fails closed", async () => {
    const resolver = createAllowlistRoleResolver({ "owner@example.com": "owner", "editor@example.com": "editor" });
    expect(resolver.resolve({ email: "owner@example.com" })?.role).toBe("owner");
    expect(resolver.resolve({ email: "EDITOR@example.com" })?.role).toBe("editor");
    expect(resolver.resolve({ email: "revoked@example.com" })).toBeNull();
    const noResolverServer = app({ sessionResolver: async () => ({ email: "owner@example.com", displayName: "Owner" }) });
    const response = await noResolverServer.request(request("/api/me"));
    expect(response.status).toBe(401);
  });

  it("serves anonymous catalog with an ETag and supports conditional reads", async () => {
    const server = app();
    const first = await server.request(request("/api/catalog"));
    expect(first.status).toBe(200);
    expect(first.headers.get("ETag")).toMatch(/^"[a-f0-9]+"$/);
    expect((await first.json()).ok).toBe(true);
    const second = await server.request(request("/api/catalog", { headers: { "If-None-Match": first.headers.get("etag")! } }));
    expect(second.status).toBe(304);
  });

  it("performs a DB read and scratch write/rollback in healthz", async () => {
    const server = app();
    const response = await server.request(request("/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(database!.sqlite.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all()).toEqual([]);
  });

  it("keeps API/auth/MCP paths out of SPA fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "songbook-server-assets-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    try {
      const server = app({ assetsRoot: root });
      expect((await server.request(request("/catalog"))).status).toBe(200);
      expect((await server.request(request("/api/unknown"))).status).toBe(404);
      expect((await server.request(request("/mcp/unknown"))).status).toBe(404);
      expect((await server.request(request("/.well-known/unknown"))).status).toBe(404);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("requires JSON and exact same-origin for browser mutations", async () => {
    const server = app({ sessionResolver: async () => ({ email: "editor@example.com", displayName: "Editor" }) });
    const noJson = await server.request(request("/api/performances", { method: "POST", headers: { Origin: origin }, body: "{}" }));
    expect(noJson.status).toBe(415);
    const wrongOrigin = await server.request(request("/api/performances", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" }));
    expect(wrongOrigin.status).toBe(403);
  });

  it("rejects bearer credentials on browser API routes", async () => {
    const server = app({ sessionResolver: async () => ({ email: "editor@example.com", displayName: "Editor" }) });
    const response = await server.request(request("/api/me", { headers: { Authorization: "Bearer invalid" } }));
    expect(response.status).toBe(401);
  });

  it("rechecks the current role resolver rather than trusting a session role", async () => {
    const server = app({
      sessionResolver: async () => ({ email: "revoked@example.com", displayName: "Revoked" }),
      roleResolver: { resolve: () => null }
    });
    const response = await server.request(request("/api/me"));
    expect(response.status).toBe(401);
  });
});

describe("MCP OAuth resource-server gate", () => {
  it("binds opaque Better Auth tokens to the canonical resource and rejects cookie auth", async () => {
    database = openDatabase();
    const auth = { api: { getMcpSession: async () => ({ userId: "user-1" }) } } as never;
    const adapter = createMcpAuthAdapter({ auth, database, origin });
    await adapter.captureToken(new Response(JSON.stringify({ access_token: "opaque-token", expires_in: 60, scope: "songbook:read" }), { headers: { "Content-Type": "application/json" } }), new Request(`${origin}/mcp/token`));
    const accepted = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer opaque-token" } }), ["songbook:read"]);
    expect(accepted.ok).toBe(true);
    const cookie = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer opaque-token", Cookie: "better-auth.session_token=stale" } }), ["songbook:read"]);
    expect(cookie.ok).toBe(false);
  });

  it("rejects a token whose application-owned audience/resource binding is wrong", async () => {
    database = openDatabase();
    database.sqlite.prepare("INSERT INTO mcp_token_resources (access_token, resource, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run("wrong-audience", "https://other.example/mcp", "songbook:read", new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    const adapter = createMcpAuthAdapter({ auth: { api: { getMcpSession: async () => ({}) } } as never, database, origin });
    const result = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer wrong-audience" } }), ["songbook:read"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects missing scopes before invoking the auth provider", async () => {
    database = openDatabase();
    let invoked = false;
    const auth = { api: { getMcpSession: async () => { invoked = true; return {}; } } } as never;
    const adapter = createMcpAuthAdapter({ auth, database, origin });
    await adapter.captureToken(new Response(JSON.stringify({ access_token: "read-only", expires_in: 60, scope: "songbook:read" })), new Request(`${origin}/mcp/token`));
    const result = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer read-only" } }), ["songbook:write"]);
    expect(result.ok).toBe(false);
    expect(invoked).toBe(false);
  });

  it("does not accept an opaque token that was never captured", async () => {
    database = openDatabase();
    const adapter = createMcpAuthAdapter({ auth: { api: { getMcpSession: async () => ({}) } } as never, database, origin });
    const result = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer never-captured" } }), ["songbook:read"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("captures successful token responses through both exposed issuance aliases", async () => {
    database = openDatabase();
    const captured: string[] = [];
    const fakeAuth = { handler: async () => new Response(JSON.stringify({ access_token: "alias-token", expires_in: 60, scope: "songbook:read" }), { headers: { "Content-Type": "application/json" } }) };
    const server = createServerApp({
      database,
      origin,
      auth: fakeAuth as never,
      mcpAuth: {
        captureToken: async (response) => { captured.push((await response.json()).access_token as string); },
        verifyRequest: async () => ({ ok: false, response: new Response(null, { status: 401 }) })
      }
    }).app;
    expect((await server.request(request("/mcp/token", { method: "POST" }))).status).toBe(200);
    expect((await server.request(request("/api/auth/mcp/token", { method: "POST" }))).status).toBe(200);
    expect(captured).toEqual(["alias-token", "alias-token"]);
    const directDiscovery = await server.request(request("/api/auth/.well-known/oauth-authorization-server"));
    expect((await directDiscovery.json()).scopes_supported).toContain("songbook:read");
  });
});
