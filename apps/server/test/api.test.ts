import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type SongbookDatabase } from "@songbook/server-core";
import { createServerApp } from "../src/api.js";
import { allowedUserMap, createAllowlistRoleResolver, createMcpAuthAdapter, mcpScopeFromString } from "../src/auth.js";

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
  it("resolves normalized allowlisted users and fails closed", async () => {
    const resolver = createAllowlistRoleResolver(["allowed@example.com", "peer@example.com"]);
    expect(resolver.resolve({ email: "ALLOWED@example.com" })?.role).toBe("allowed");
    expect(resolver.resolve({ email: "PEER@example.com" })?.role).toBe("allowed");
    expect(resolver.resolve({ email: "revoked@example.com" })).toBeNull();
    const noResolverServer = app({ sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }) });
    const response = await noResolverServer.request(request("/api/me"));
    expect(response.status).toBe(401);
  });

  it("keeps MCP authorization to read and write scopes", () => {
    expect(mcpScopeFromString("songbook:read songbook:write songbook:admin")).toEqual(["songbook:read", "songbook:write"]);
  });

  it("rejects malformed programmatic allowlists instead of admitting a valid subset", () => {
    expect(allowedUserMap(undefined)).toEqual(new Map());
    expect(() => allowedUserMap([])).toThrow("non-empty array");
    expect(() => allowedUserMap(["allowed@example.com", "not-an-email"])).toThrow("valid email strings");
    expect(() => allowedUserMap(["allowed@example.com", "ALLOWED@example.com"])).toThrow("duplicate");
    expect(() => createAllowlistRoleResolver(["allowed@example.com", "not-an-email"])).toThrow("valid email strings");
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
    const server = app({ sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }) });
    const noJson = await server.request(request("/api/performances", { method: "POST", headers: { Origin: origin }, body: "{}" }));
    expect(noJson.status).toBe(415);
    const wrongOrigin = await server.request(request("/api/performances", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" }));
    expect(wrongOrigin.status).toBe(403);
  });

  it("maps malformed and schema-invalid JSON bodies to validation errors", async () => {
    const server = app({
      sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }),
      roleResolver: createAllowlistRoleResolver(["allowed@example.com"])
    });
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const malformed = await server.request(request("/api/songs", { method: "POST", headers, body: "{" }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("VALIDATION_ERROR");
    const invalid = await server.request(request("/api/songs", { method: "POST", headers, body: "{}" }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("allows every allowlisted user to delete and rejects unknown users", async () => {
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const allowedServer = app({
      sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }),
      roleResolver: createAllowlistRoleResolver(["allowed@example.com"])
    });
    const created = await allowedServer.request(
      request("/api/songs", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "삭제 대상", artist: "가수", clientRequestId: crypto.randomUUID() })
      })
    );
    expect(created.status).toBe(200);
    const song = (await created.json()).data;

    const deleted = await allowedServer.request(
      request(`/api/songs/${song.id}/delete`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ songId: song.id, expectedVersion: song.version, clientRequestId: crypto.randomUUID() })
      })
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data.id).toBe(song.id);

    const catalog = await allowedServer.request(request("/api/catalog"));
    expect((await catalog.json()).data.songs.map((entry: { id: string }) => entry.id)).not.toContain(song.id);

    const reAdded = await allowedServer.request(
      request("/api/songs", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "삭제 대상", artist: "가수", clientRequestId: crypto.randomUUID() })
      })
    );
    expect(reAdded.status).toBe(200);
    expect((await reAdded.json()).data.id).not.toBe(song.id);

    const unknownServer = app({
      sessionResolver: async () => ({ email: "unknown@example.com", displayName: "Unknown" }),
      roleResolver: createAllowlistRoleResolver(["allowed@example.com"])
    });
    const madeByAllowed = await allowedServer.request(
      request("/api/songs", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "허용된 곡", artist: "가수", clientRequestId: crypto.randomUUID() })
      })
    );
    const allowedSong = (await madeByAllowed.json()).data;
    const forbidden = await unknownServer.request(
      request(`/api/songs/${allowedSong.id}/delete`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ songId: allowedSong.id, expectedVersion: allowedSong.version, clientRequestId: crypto.randomUUID() })
      })
    );
    expect(forbidden.status).toBe(401);
  });

  it("returns the browser session contract with name and expiry fields", async () => {
    const server = app({
      sessionResolver: async () => ({ id: "session-1", email: "allowed@example.com", displayName: "Allowed", expiresAt: "2026-08-14T00:00:00.000Z" }),
      roleResolver: createAllowlistRoleResolver(["allowed@example.com"])
    });
    const response = await server.request(request("/api/session"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ user: { id: "session-1", email: "allowed@example.com", name: "Allowed", role: "allowed" }, session: { id: "session-1", expiresAt: "2026-08-14T00:00:00.000Z" } });
  });

  it("rejects bearer credentials on browser API routes", async () => {
    const server = app({ sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }) });
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
  it("runs the stateless MCP handler only after bearer verification", async () => {
    database = openDatabase();
    let verified = false;
    let verifiedScopes: string[] = [];
    const server = createServerApp({
      database,
      origin,
      mcpAuth: {
        captureToken: async () => undefined,
        verifyRequest: async (request, requiredScopes) => {
          verified = true;
          verifiedScopes = requiredScopes;
          expect(request.headers.get("Authorization")).toBe("Bearer accepted");
          return {
            ok: true,
            token: { accessToken: "accepted", resource: `${origin}/mcp`, scopes: ["songbook:read"], expiresAt: new Date(Date.now() + 60_000).toISOString() },
            session: { userId: "user-1" },
            principal: { userId: "user-1", actor: { email: "allowed@example.com", displayName: "Allowed" } }
          };
        }
      },
      roleResolver: createAllowlistRoleResolver(["allowed@example.com"])
    }).app;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } });
    const response = await server.request(request("/mcp", { method: "POST", headers: { Authorization: "Bearer accepted", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" }, body }));
    expect(verified).toBe(true);
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "catalog" })]));
    const search = await server.request(request("/mcp", { method: "POST", headers: { Authorization: "Bearer accepted", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "search_songs" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_songs", arguments: { query: "Song" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }) }));
    expect(search.status).toBe(200);
    expect(verifiedScopes).toEqual(["songbook:read"]);
  });

  it("allows anonymous public discovery and protected calls start OAuth", async () => {
    database = openDatabase();
    const server = createServerApp({
      database,
      origin,
      mcpAuth: {
        captureToken: async () => undefined,
        verifyRequest: async () => ({ ok: false, response: new Response("should not run", { status: 500 }) })
      }
    }).app;
    const listed = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": "tools/list" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
    expect(listed.status).toBe(200);
    const cookiePublic = await server.request(request("/mcp", { method: "POST", headers: { Cookie: "better-auth.session_token=browser-only", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 15, method: "tools/list", params: {} }) }));
    expect(cookiePublic.status).toBe(200);
    const cookieProtected = await server.request(request("/mcp", { method: "POST", headers: { Cookie: "better-auth.session_token=browser-only", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "record_performance", arguments: {} } }) }));
    expect(cookieProtected.status).toBe(401);
    expect(cookieProtected.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    const protectedCall = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": "tools/call", "Mcp-Name": "catalog" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "record_performance", arguments: {} } }) }));
    expect(protectedCall.status).toBe(401);
    expect(protectedCall.headers.get("WWW-Authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("routes anonymous MCP from the body, ignores method/name headers, and fails closed", async () => {
    database = openDatabase();
    const server = createServerApp({ database, origin }).app;
    const publicWithProtectedHeader = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "delete_song" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }) }));
    expect(publicWithProtectedHeader.status).toBe(200);
    const protectedWithPublicHeader = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "catalog" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_song", arguments: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }) }));
    expect(protectedWithPublicHeader.status).toBe(401);
    const batch = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }]) }));
    expect(batch.status).toBe(401);
    const malformed = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }));
    expect(malformed.status).toBe(401);
    expect((await server.request(request("/mcp", { method: "GET" }))).status).not.toBe(401);
    expect((await server.request(request("/mcp", { method: "DELETE" }))).status).not.toBe(401);
  });

  it("binds opaque Better Auth tokens to the canonical resource and rejects cookie auth", async () => {
    database = openDatabase();
    const auth = { api: { getMcpSession: async () => ({ userId: "user-1" }) }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => ({ email: "allowed@example.com", name: "Allowed" }) } }) } as never;
    const adapter = createMcpAuthAdapter({ auth, database, origin });
    await adapter.captureToken(new Response(JSON.stringify({ access_token: "opaque-token", expires_in: 60, scope: "songbook:read" }), { headers: { "Content-Type": "application/json" } }), new Request(`${origin}/mcp/token`));
    const accepted = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer opaque-token" } }), ["songbook:read"]);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.principal).toEqual({ userId: "user-1", actor: { email: "allowed@example.com", displayName: "Allowed" } });
    const cookie = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer opaque-token", Cookie: "better-auth.session_token=stale" } }), ["songbook:read"]);
    expect(cookie.ok).toBe(false);
  });

  it("rejects malformed and invalid bearer headers without anonymous downgrade", async () => {
    database = openDatabase();
    const auth = { api: { getMcpSession: async () => ({ userId: "user-1" }) }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => ({ email: "allowed@example.com", name: "Allowed" }) } }) } as never;
    const adapter = createMcpAuthAdapter({ auth, database, origin });
    for (const value of ["Basic abc", "Bearer", "Bearer "]) {
      const response = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: value } }), []);
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.response.headers.get("WWW-Authenticate")).toContain("invalid_token");
    }
    const invalid = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer never-valid" } }), []);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.response.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("rejects a token whose application-owned audience/resource binding is wrong", async () => {
    database = openDatabase();
    database.sqlite.prepare("INSERT INTO mcp_token_resources (access_token, resource, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run("wrong-audience", "https://other.example/mcp", "songbook:read", new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    const adapter = createMcpAuthAdapter({ auth: { api: { getMcpSession: async () => ({}) }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => null } }) } as never, database, origin });
    const result = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer wrong-audience" } }), ["songbook:read"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("rejects expired and revoked opaque tokens with invalid-token challenges", async () => {
    database = openDatabase();
    database.sqlite.prepare("INSERT INTO mcp_token_resources (access_token, resource, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run("expired", `${origin}/mcp`, "songbook:read", new Date(Date.now() - 1_000).toISOString(), new Date().toISOString());
    const expiredAdapter = createMcpAuthAdapter({ auth: { api: { getMcpSession: async () => ({ userId: "user-1" }) }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => ({ email: "allowed@example.com" }) } }) } as never, database, origin });
    const expired = await expiredAdapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer expired" } }), []);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.response.headers.get("WWW-Authenticate")).toContain("invalid_token");

    const revokedAdapter = createMcpAuthAdapter({ auth: { api: { getMcpSession: async () => null }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => null } }) } as never, database, origin });
    await revokedAdapter.captureToken(new Response(JSON.stringify({ access_token: "revoked", expires_in: 60, scope: "songbook:read" })), new Request(`${origin}/mcp/token`));
    const revoked = await revokedAdapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer revoked" } }), []);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.response.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("rejects missing scopes before invoking the auth provider", async () => {
    database = openDatabase();
    let invoked = false;
    const auth = { api: { getMcpSession: async () => { invoked = true; return {}; } }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => null } }) } as never;
    const adapter = createMcpAuthAdapter({ auth, database, origin });
    await adapter.captureToken(new Response(JSON.stringify({ access_token: "read-only", expires_in: 60, scope: "songbook:read" })), new Request(`${origin}/mcp/token`));
    const result = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer read-only" } }), ["songbook:write"]);
    expect(result.ok).toBe(false);
    expect(invoked).toBe(false);
  });

  it("does not accept an opaque token that was never captured", async () => {
    database = openDatabase();
    const adapter = createMcpAuthAdapter({ auth: { api: { getMcpSession: async () => ({}) }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => null } }) } as never, database, origin });
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
    const metadata = await directDiscovery.json();
    expect(metadata).toEqual(expect.objectContaining({ issuer: `${origin}/api/auth`, authorization_endpoint: `${origin}/api/auth/mcp/authorize`, token_endpoint: `${origin}/api/auth/mcp/token`, registration_endpoint: `${origin}/api/auth/mcp/register` }));
    expect(await (await server.request(request("/.well-known/oauth-authorization-server"))).json()).toEqual(metadata);
    expect(await (await server.request(request("/.well-known/oauth-protected-resource/mcp"))).json()).toEqual({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/api/auth`], jwks_uri: `${origin}/api/auth/mcp/jwks`, scopes_supported: ["songbook:read", "songbook:write"], bearer_methods_supported: ["header"], resource_signing_alg_values_supported: ["RS256"] });
    expect(await (await server.request(request("/.well-known/oauth-protected-resource"))).json()).toEqual(await (await server.request(request("/api/auth/.well-known/oauth-protected-resource"))).json());
  });

  it("rejects a valid opaque token when its authoritative user is not allowlisted", async () => {
    database = openDatabase();
    const auth = { api: { getMcpSession: async () => ({ userId: "user-1" }) }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => ({ email: "revoked@example.com", name: "Revoked" }) } }) } as never;
    const adapter = createMcpAuthAdapter({ auth, database, origin });
    await adapter.captureToken(new Response(JSON.stringify({ access_token: "revoked-token", expires_in: 60, scope: "songbook:read" })), new Request(`${origin}/mcp/token`));
    const server = createServerApp({ database, origin, mcpAuth: adapter }).app;
    expect((await server.request(request("/mcp", { headers: { Authorization: "Bearer revoked-token" } }))).status).toBe(401);
  });
});
