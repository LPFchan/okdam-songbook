import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReadableStream } from "node:stream/web";
import { openDatabase, type SongbookDatabase, type TjAdapter } from "@songbook/server-core";
import { createServerApp } from "../src/api.js";
import { createCommonAuthRoleResolver } from "../src/auth.js";

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
  it("resolves identities already admitted by common auth and fails closed without a resolver", async () => {
    const resolver = createCommonAuthRoleResolver();
    expect(resolver.resolve({ email: "ALLOWED@example.com" })?.role).toBe("allowed");
    expect(resolver.resolve({ email: "PEER@example.com", displayName: "여울" })?.displayName).toBe("여울");
    const noResolverServer = app({ sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }) });
    const response = await noResolverServer.request(request("/api/me"));
    expect(response.status).toBe(401);
  });

  it("returns the immutable Common Auth subject to the browser", async () => {
    const server = app({
      sessionResolver: async () => ({ subject: "auth.lost.plus:42", email: "allowed@example.com", displayName: "Allowed" }),
      roleResolver: createCommonAuthRoleResolver()
    });
    const response = await server.request(request("/api/me"));
    expect(response.status).toBe(200);
    expect((await response.json()).data.subject).toBe("auth.lost.plus:42");
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

  it("keeps favorites behind the session and isolated by account", async () => {
    let email = "allowed@example.com";
    const server = app({
      sessionResolver: async () => email ? { email, displayName: email } : null,
      roleResolver: createCommonAuthRoleResolver()
    });
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Songbook-Owner-Subject": "legacy-email:allowed@example.com" };
    const createdResponse = await server.request(request("/api/songs", {
      method: "POST", headers, body: JSON.stringify({ title: "Private favorite", artist: "Artist", clientRequestId: crypto.randomUUID() })
    }));
    const created = (await createdResponse.json()).data;
    const set = await server.request(request(`/api/favorites/${created.id}`, {
      method: "POST", headers, body: JSON.stringify({ favorite: true, clientRequestId: crypto.randomUUID() })
    }));
    expect(set.status).toBe(200);
    expect((await set.json()).data).toEqual({ ownerSubject: "legacy-email:allowed@example.com", songId: created.id, favorite: true });
    expect((await (await server.request(request("/api/favorites"))).json()).data.songIds).toEqual([created.id]);

    email = "peer@example.com";
    expect((await (await server.request(request("/api/favorites"))).json()).data.songIds).toEqual([]);
    email = "";
    expect((await server.request(request("/api/favorites"))).status).toBe(401);
    const catalog = await (await server.request(request("/api/catalog"))).json();
    expect(Object.hasOwn(catalog.data.songs[0], "favorite")).toBe(false);
    expect(JSON.stringify(catalog.data)).not.toContain("allowed@example.com");
  });

  it("keeps favorites with the immutable account subject across email changes", async () => {
    let principal = { subject: "auth.lost.plus:42", email: "old@example.com", displayName: "User" };
    const server = app({
      sessionResolver: async () => principal,
      roleResolver: createCommonAuthRoleResolver()
    });
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Songbook-Owner-Subject": "auth.lost.plus:42" };
    const created = (await (await server.request(request("/api/songs", {
      method: "POST", headers, body: JSON.stringify({ title: "Stable favorite", artist: "Artist", clientRequestId: crypto.randomUUID() })
    }))).json()).data;
    await server.request(request(`/api/favorites/${created.id}`, {
      method: "POST", headers, body: JSON.stringify({ favorite: true, clientRequestId: crypto.randomUUID() })
    }));

    principal = { ...principal, email: "new@example.com" };
    expect((await (await server.request(request("/api/favorites"))).json()).data.songIds).toEqual([created.id]);
    principal = { subject: "auth.lost.plus:99", email: "old@example.com", displayName: "Other" };
    expect((await (await server.request(request("/api/favorites"))).json()).data.songIds).toEqual([]);
  });

  it("rejects a replay bound to a different Common Auth subject", async () => {
    const server = app({
      sessionResolver: async () => ({ subject: "auth.lost.plus:99", email: "new@example.com", displayName: "New" }),
      roleResolver: createCommonAuthRoleResolver()
    });
    const response = await server.request(request("/api/performances", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Songbook-Owner-Subject": "auth.lost.plus:42"
      },
      body: JSON.stringify({ songId: "song-1", performedAt: "2026-08-21T10:00:00.000Z", clientRequestId: crypto.randomUUID() })
    }));

    expect(response.status).toBe(403);
  });

  it("requires an originating subject on durable and draft-derived browser operations", async () => {
    const server = app({
      sessionResolver: async () => ({ subject: "auth.lost.plus:42", email: "allowed@example.com", displayName: "Allowed" }),
      roleResolver: createCommonAuthRoleResolver()
    });
    const headers = { Origin: origin, "Content-Type": "application/json" };
    for (const [method, path] of [
      ["POST", "/api/favorites/song-1"],
      ["POST", "/api/performances"],
      ["DELETE", "/api/performances/performance-1"],
      ["POST", "/api/songs"],
      ["PATCH", "/api/songs/song-1"],
      ["DELETE", "/api/songs/song-1/delete"],
      ["POST", "/api/readings/generate"],
      ["POST", "/api/tj/add"]
    ] as const) {
      const response = await server.request(request(path, { method, headers, body: "{}" }));
      expect(response.status, `${method} ${path}`).toBe(403);
      expect((await response.json()).error.code).toBe("FORBIDDEN");
    }
  });

  it("rejects favorite reads and writes bound to another Common Auth subject", async () => {
    const server = app({
      sessionResolver: async () => ({ subject: "auth.lost.plus:99", email: "reused@example.com", displayName: "New" }),
      roleResolver: createCommonAuthRoleResolver()
    });
    const ownerHeaders = { "X-Songbook-Owner-Subject": "auth.lost.plus:42" };

    expect((await server.request(request("/api/favorites", { headers: ownerHeaders }))).status).toBe(403);
    const write = await server.request(request("/api/favorites/song-1", {
      method: "POST",
      headers: { ...ownerHeaders, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ favorite: true, clientRequestId: crypto.randomUUID() })
    }));
    expect(write.status).toBe(403);
  });

  it("publishes the mapped latest singer name without publishing an email", async () => {
    const server = app({
      sessionResolver: async () => ({ email: "allowed@example.com", displayName: "마리" }),
      roleResolver: createCommonAuthRoleResolver()
    });
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Songbook-Owner-Subject": "legacy-email:allowed@example.com" };
    const created = await server.request(request("/api/songs", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "노래", artist: "가수", clientRequestId: crypto.randomUUID() })
    }));
    const song = (await created.json()).data;
    await server.request(request("/api/performances", {
      method: "POST",
      headers,
      body: JSON.stringify({ songId: song.id, performedAt: "2026-08-21T10:00:00.000Z", clientRequestId: crypto.randomUUID() })
    }));

    const response = await server.request(request("/api/catalog"));
    const body = await response.json();
    expect(body.data.songs[0]).toMatchObject({ lastPerformedByName: "마리", performanceCount: 1 });
    expect(JSON.stringify(body.data.songs)).not.toContain("allowed@example.com");
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

  it("denies framing for direct and fallback HTML", async () => {
    const root = mkdtempSync(join(tmpdir(), "songbook-server-assets-"));
    writeFileSync(join(root, "index.html"), "<html>app</html>");
    try {
      const server = app({ assetsRoot: root });
      for (const path of ["/", "/admin"]) {
        const response = await server.request(request(path));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        expect(response.headers.get("x-frame-options")).toBe("DENY");
      }
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
      roleResolver: createCommonAuthRoleResolver()
    });
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Songbook-Owner-Subject": "legacy-email:allowed@example.com" };
    const malformed = await server.request(request("/api/songs", { method: "POST", headers, body: "{" }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("VALIDATION_ERROR");
    const invalid = await server.request(request("/api/songs", { method: "POST", headers, body: "{}" }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("generates editable Korean reading candidates for an allowlisted session", async () => {
    let received: unknown;
    const server = app({
      sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }),
      roleResolver: createCommonAuthRoleResolver(),
      readingGenerator: {
        generate: async (input) => {
          received = input;
          return { titleReadingKo: "아이도루", artistReadingKo: "요아소비" };
        }
      }
    });
    const response = await server.request(request("/api/readings/generate", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Songbook-Owner-Subject": "legacy-email:allowed@example.com" },
      body: JSON.stringify({ title: "  アイドル  ", artist: "YOASOBI" })
    }));
    expect(response.status).toBe(200);
    expect(received).toEqual({ title: "アイドル", artist: "YOASOBI" });
    expect((await response.json()).data).toEqual({ titleReadingKo: "아이도루", artistReadingKo: "요아소비" });
  });

  it("fails safely when reading generation is unconfigured or input is empty", async () => {
    const server = app({
      sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }),
      roleResolver: createCommonAuthRoleResolver()
    });
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Songbook-Owner-Subject": "legacy-email:allowed@example.com" };
    const unconfigured = await server.request(request("/api/readings/generate", {
      method: "POST", headers, body: JSON.stringify({ title: "曲", artist: "歌手" })
    }));
    expect(unconfigured.status).toBe(503);
    expect((await unconfigured.json()).error.code).toBe("AI_NOT_CONFIGURED");

    const configured = app({
      sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }),
      roleResolver: createCommonAuthRoleResolver(),
      readingGenerator: { generate: async () => ({ titleReadingKo: "", artistReadingKo: "" }) }
    });
    const empty = await configured.request(request("/api/readings/generate", {
      method: "POST", headers, body: JSON.stringify({ title: "  ", artist: "" })
    }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("allows every common-auth user to delete", async () => {
    const headers = { Origin: origin, "Content-Type": "application/json", "X-Songbook-Owner-Subject": "legacy-email:allowed@example.com" };
    const allowedServer = app({
      sessionResolver: async () => ({ email: "allowed@example.com", displayName: "Allowed" }),
      roleResolver: createCommonAuthRoleResolver()
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

  });

  it("returns the browser session contract with name and expiry fields", async () => {
    const server = app({
      sessionResolver: async () => ({ id: "session-1", email: "allowed@example.com", displayName: "Allowed", expiresAt: "2026-08-14T00:00:00.000Z" }),
      roleResolver: createCommonAuthRoleResolver()
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

describe("MCP common-auth gate", () => {
  it("bounds declared and chunked MCP bodies before anonymous admission", async () => {
    database = openDatabase();
    const server = createServerApp({ database, origin, mcpMaxBodyBytes: 256 }).app;
    const ordinary = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect((await server.request(request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: ordinary
    }))).status).toBe(200);

    const declared = await server.request(request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "257" },
      body: ordinary
    }));
    expect(declared.status).toBe(413);

    const chunked = await server.request(request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { capabilities: { padding: "x".repeat(512) } } })
    }));
    expect(chunked.status).toBe(413);
  });

  it("times out an MCP body that never finishes", async () => {
    database = openDatabase();
    const server = createServerApp({ database, origin, mcpBodyTimeoutMs: 10 }).app;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); }
    });
    const stalled = new Request(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    const response = await server.request(stalled);
    expect(response.status).toBe(408);
  });

  it("holds an MCP body permit until an aborted tool finishes", async () => {
    database = openDatabase();
    let searches = 0;
    let firstEntered!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const tj = {
      search: async (input) => {
        searches += 1;
        if (searches === 1) {
          firstEntered();
          await blocked;
        }
        return {
          query: input.query,
          searchType: "all" as const,
          nation: "",
          page: 1,
          pageSize: 15,
          hasMore: false,
          candidates: [],
          sourceUrl: "https://tj.example/search"
        };
      },
      lookup: async () => { throw new Error("not used"); }
    } as TjAdapter;
    const server = createServerApp({
      database,
      origin,
      mcpMaxInflightBodies: 1,
      tj,
      mcpAuth: {
        verifyRequest: async () => ({
          ok: true as const,
          token: { accessToken: "accepted", scopes: ["songbook:read"] },
          principal: { userId: "allowed@example.com", actor: { email: "allowed@example.com", displayName: "Allowed" } }
        })
      },
      roleResolver: createCommonAuthRoleResolver()
    }).app;
    const headers = {
      "X-Lost-Plus-Encoding": "percent-utf8",
      "X-Lost-Plus-Sub": "42",
      "X-Lost-Plus-Email": "allowed%40example.com",
      "X-Lost-Plus-Name": "Allowed",
      "X-Lost-Plus-Role": "user",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "search_songs"
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search_songs",
        arguments: { query: "Song" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    });
    const controller = new globalThis.AbortController();
    const first = server.request(request("/mcp", { method: "POST", headers, body, signal: controller.signal }));
    await entered;
    controller.abort();
    const second = server.request(request("/mcp", { method: "POST", headers, body }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(searches).toBe(1);
    releaseFirst();
    expect((await first).status).toBe(499);
    expect((await second).status).toBe(200);
    expect(searches).toBe(2);
  });

  it("runs the stateless MCP handler only after bearer verification", async () => {
    database = openDatabase();
    let verifiedScopes: string[] = [];
    const server = createServerApp({
      database,
      origin,
      mcpAuth: {
        verifyRequest: async (incoming, requiredScopes) => {
          verifiedScopes = requiredScopes;
          expect(incoming.headers.get("X-Lost-Plus-Sub")).toBe("42");
          return {
            ok: true,
            token: { accessToken: "accepted", scopes: ["songbook:read", "songbook:write"] },
            principal: { userId: "allowed@example.com", actor: { email: "allowed@example.com", displayName: "Allowed" } }
          };
        }
      },
      roleResolver: createCommonAuthRoleResolver()
    }).app;
    const headers = {
      "X-Lost-Plus-Encoding": "percent-utf8",
      "X-Lost-Plus-Sub": "42",
      "X-Lost-Plus-Email": "allowed%40example.com",
      "X-Lost-Plus-Name": "Allowed",
      "X-Lost-Plus-Role": "user",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28"
    };
    const listed = await server.request(request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }) }));
    expect(listed.status).toBe(200);
    expect((await listed.json()).result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "catalog" })]));
    const search = await server.request(request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_songs", arguments: { query: "Song" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }) }));
    expect(search.status).toBe(200);
    expect(verifiedScopes).toEqual(["songbook:read"]);
  });

  it("keeps public MCP calls anonymous and challenges protected calls for a shared bearer token", async () => {
    database = openDatabase();
    const server = createServerApp({ database, origin }).app;
    const listed = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
    expect(listed.status).toBe(200);
    const protectedCall = await server.request(request("/mcp", { method: "POST", headers: { Cookie: "lp_auth=browser-only", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "record_performance", arguments: {} } }) }));
    expect(protectedCall.status).toBe(401);
    expect(protectedCall.headers.get("WWW-Authenticate")).toBe('Bearer realm="auth.lost.plus"');
  });

  it("routes anonymous MCP from the body and fails closed for malformed or protected input", async () => {
    database = openDatabase();
    const server = createServerApp({ database, origin }).app;
    const publicWithProtectedHeader = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Name": "delete_song" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "catalog", arguments: {} } }) }));
    expect(publicWithProtectedHeader.status).toBe(200);
    const protectedWithPublicHeader = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", "Mcp-Name": "catalog" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delete_song", arguments: {} } }) }));
    expect(protectedWithPublicHeader.status).toBe(401);
    const batch = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }]) }));
    expect(batch.status).toBe(401);
    const malformed = await server.request(request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }));
    expect(malformed.status).toBe(401);
  });
});
