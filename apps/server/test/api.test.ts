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

  it("maps malformed and schema-invalid JSON bodies to validation errors", async () => {
    const server = app({
      sessionResolver: async () => ({ email: "editor@example.com", displayName: "Editor" }),
      roleResolver: createAllowlistRoleResolver({ "editor@example.com": "editor" })
    });
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const malformed = await server.request(request("/api/songs", { method: "POST", headers, body: "{" }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("VALIDATION_ERROR");
    const invalid = await server.request(request("/api/songs", { method: "POST", headers, body: "{}" }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("soft-deletes a song as owner and rejects editors", async () => {
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const ownerServer = app({
      sessionResolver: async () => ({ email: "owner@example.com", displayName: "Owner" }),
      roleResolver: createAllowlistRoleResolver({ "owner@example.com": "owner" })
    });
    const created = await ownerServer.request(
      request("/api/songs", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "삭제 대상", artist: "가수", clientRequestId: crypto.randomUUID() })
      })
    );
    expect(created.status).toBe(200);
    const song = (await created.json()).data;

    const deleted = await ownerServer.request(
      request(`/api/songs/${song.id}/delete`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ songId: song.id, expectedVersion: song.version, clientRequestId: crypto.randomUUID() })
      })
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).data.deletedAt).not.toBe("");

    const catalog = await ownerServer.request(request("/api/catalog"));
    expect((await catalog.json()).data.songs.map((entry: { id: string }) => entry.id)).not.toContain(song.id);

    const editorServer = app({
      sessionResolver: async () => ({ email: "editor@example.com", displayName: "Editor" }),
      roleResolver: createAllowlistRoleResolver({ "editor@example.com": "editor" })
    });
    const madeByEditor = await editorServer.request(
      request("/api/songs", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "편집자 곡", artist: "가수", clientRequestId: crypto.randomUUID() })
      })
    );
    const editorSong = (await madeByEditor.json()).data;
    const forbidden = await editorServer.request(
      request(`/api/songs/${editorSong.id}/delete`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ songId: editorSong.id, expectedVersion: editorSong.version, clientRequestId: crypto.randomUUID() })
      })
    );
    expect(forbidden.status).toBe(403);
  });

  it("returns the browser session contract with name and expiry fields", async () => {
    const server = app({
      sessionResolver: async () => ({ id: "session-1", email: "editor@example.com", displayName: "Editor", expiresAt: "2026-08-14T00:00:00.000Z" }),
      roleResolver: createAllowlistRoleResolver({ "editor@example.com": "editor" })
    });
    const response = await server.request(request("/api/session"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ user: { id: "session-1", email: "editor@example.com", name: "Editor", role: "editor" }, session: { id: "session-1", expiresAt: "2026-08-14T00:00:00.000Z" } });
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
  it("runs the stateless MCP handler only after bearer verification", async () => {
    database = openDatabase();
    let verified = false;
    const server = createServerApp({
      database,
      origin,
      mcpAuth: {
        captureToken: async () => undefined,
        verifyRequest: async (request) => {
          verified = true;
          expect(request.headers.get("Authorization")).toBe("Bearer accepted");
          return {
            ok: true,
            token: { accessToken: "accepted", resource: `${origin}/mcp`, scopes: ["songbook:read"], expiresAt: new Date(Date.now() + 60_000).toISOString() },
            session: { userId: "user-1" },
            principal: { userId: "user-1", actor: { email: "owner@example.com", displayName: "Owner" } }
          };
        }
      },
      roleResolver: createAllowlistRoleResolver({ "owner@example.com": "owner" })
    }).app;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } });
    const response = await server.request(request("/mcp", { method: "POST", headers: { Authorization: "Bearer accepted", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" }, body }));
    expect(verified).toBe(true);
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "catalog" })]));
  });

  it("rejects MCP requests before the handler when bearer verification fails", async () => {
    database = openDatabase();
    let handlerReached = false;
    const server = createServerApp({
      database,
      origin,
      mcpAuth: {
        captureToken: async () => undefined,
        verifyRequest: async () => { handlerReached = true; return { ok: false, response: new Response("unauthorized", { status: 401 }) }; }
      }
    }).app;
    const response = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": "tools/list" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
    expect(handlerReached).toBe(true);
    expect(response.status).toBe(401);
  });

  it("binds opaque Better Auth tokens to the canonical resource and rejects cookie auth", async () => {
    database = openDatabase();
    const auth = { api: { getMcpSession: async () => ({ userId: "user-1" }) }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => ({ email: "owner@example.com", name: "Owner" }) } }) } as never;
    const adapter = createMcpAuthAdapter({ auth, database, origin });
    await adapter.captureToken(new Response(JSON.stringify({ access_token: "opaque-token", expires_in: 60, scope: "songbook:read" }), { headers: { "Content-Type": "application/json" } }), new Request(`${origin}/mcp/token`));
    const accepted = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer opaque-token" } }), ["songbook:read"]);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.principal).toEqual({ userId: "user-1", actor: { email: "owner@example.com", displayName: "Owner" } });
    const cookie = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer opaque-token", Cookie: "better-auth.session_token=stale" } }), ["songbook:read"]);
    expect(cookie.ok).toBe(false);
  });

  it("rejects a token whose application-owned audience/resource binding is wrong", async () => {
    database = openDatabase();
    database.sqlite.prepare("INSERT INTO mcp_token_resources (access_token, resource, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run("wrong-audience", "https://other.example/mcp", "songbook:read", new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    const adapter = createMcpAuthAdapter({ auth: { api: { getMcpSession: async () => ({}) }, $context: Promise.resolve({ internalAdapter: { findUserById: async () => null } }) } as never, database, origin });
    const result = await adapter.verifyRequest(new Request(`${origin}/mcp`, { headers: { Authorization: "Bearer wrong-audience" } }), ["songbook:read"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
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
    expect(await (await server.request(request("/.well-known/oauth-protected-resource/mcp"))).json()).toEqual({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/api/auth`], jwks_uri: `${origin}/api/auth/mcp/jwks`, scopes_supported: ["songbook:read", "songbook:write", "songbook:admin"], bearer_methods_supported: ["header"], resource_signing_alg_values_supported: ["RS256"] });
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
