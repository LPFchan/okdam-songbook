import { describe, expect, it, vi } from "vitest";
import { authInfoForPrincipal, createSongbookMcpHandler, mcpContract, mcpPackage, mcpRequiredScopeForBody, mcpToolPolicy } from "../src/index.js";
import type { SongbookService, TjAdapter } from "@songbook/server-core";

const actor = { email: "allowed@example.com", displayName: "Allowed" };
const authInfo = authInfoForPrincipal({ actor, userId: "user-1", scopes: ["songbook:read", "songbook:write"] }, "token-1");

const song = {
  id: "song-1", tjNumber: "123", title: "Song", titleReadingKo: "", artist: "Artist", artistReadingKo: "", country: "", recommendedKey: null, performerIds: [], memo: "", sourceType: "", sourceReference: "", createdByName: "", createdAt: "2026-01-01T00:00:00.000Z", updatedByName: "", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: "", version: 1, lastPerformedAt: "", performanceCount: 0
} as const;

function tjResult(query: string, searchType: "all" | "number", candidates: Awaited<ReturnType<TjAdapter["search"]>>["candidates"] = []): Awaited<ReturnType<TjAdapter["search"]>> {
  return { query, searchType, nation: "", page: 1, pageSize: 15, hasMore: false, candidates, sourceUrl: "https://tj.example/search" };
}

function service(): SongbookService {
  return {
    catalog: vi.fn(() => [song]),
    getSong: vi.fn(() => song),
    search: vi.fn(() => [song]),
    checkDuplicate: vi.fn(() => song),
    createPerformance: vi.fn(() => ({ id: "performance-1" })),
    cancelPerformance: vi.fn(() => ({ id: "performance-1" })),
    createSong: vi.fn(() => song),
    createSongOutcome: vi.fn(() => ({ outcome: "created", song, existing: null, duplicateKind: null, canRestore: false, canOpen: true })),
    createTjSong: vi.fn(() => ({ outcome: "created", song, existing: null, duplicateKind: null, canRestore: false, canOpen: true })),
    updateSong: vi.fn(() => song),
    deleteSong: vi.fn(() => song),
    performanceStats: vi.fn(() => ({ count: 0, lastPerformedAt: "" }))
  } as unknown as SongbookService;
}

function modernRequest(message: Record<string, unknown>, modern = true): Request {
  if (modern && message.method !== "initialize") {
    const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
    message = { ...message, params: { ...params, _meta: { ...(params._meta as Record<string, unknown> | undefined), "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (modern && message.method !== "initialize") {
    headers["MCP-Protocol-Version"] = "2026-07-28";
    headers["Mcp-Method"] = String(message.method);
    if (message.method === "tools/call" && message.params && typeof message.params === "object" && typeof (message.params as { name?: unknown }).name === "string") headers["Mcp-Name"] = String((message.params as { name: string }).name);
  }
  return new Request("https://songbook.example/mcp", { method: "POST", headers, body: JSON.stringify(message) });
}

describe("stateless Songbook MCP", () => {
  it("exposes the package and only the stable policy tools", () => {
    expect(mcpPackage).toBe("@songbook/mcp");
    expect(Object.keys(mcpToolPolicy).sort()).toEqual([
      "cancel_performance", "catalog", "create_song", "delete_song", "get_song", "record_performance", "search_songs", "update_song"
    ]);
    expect(mcpToolPolicy.search_songs).toEqual({ access: "public", requiredScope: "songbook:read" });
    expect(mcpToolPolicy.delete_song).toEqual({ access: "write", requiredScope: "songbook:write" });
    expect(mcpContract.mount).toEqual({ authentication: "optional-oauth", path: "/mcp", audience: "songbook-mcp", stateless: true });
    expect(mcpRequiredScopeForBody({ method: "tools/call", params: { name: "record_performance" } })).toBe("songbook:write");
    expect(mcpRequiredScopeForBody({ method: "tools/call", params: { name: "search_songs" } })).toBe("songbook:read");
    expect(mcpRequiredScopeForBody({ method: "tools/call", params: { name: "delete_song" } })).toBe("songbook:write");
    expect(mcpRequiredScopeForBody({ method: "tools/call", params: { name: "catalog" } })).toBeNull();
    expect(mcpRequiredScopeForBody({ method: "tools/call", params: { name: "unknown" } })).toBeUndefined();
  });

  it("answers anonymous initialize, list, and public calls", async () => {
    const handler = createSongbookMcpHandler({ service: service() });
    expect((await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, false))).status).toBe(200);
    const listed = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    expect((await listed.json()).result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(Object.keys(mcpToolPolicy).sort());
    const publicCall = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "catalog", arguments: {} } }));
    expect((await publicCall.json()).result.structuredContent.ok).toBe(true);
  });

  it("keeps protected tool guards separate from public tools", async () => {
    const serviceDouble = service();
    const handler = createSongbookMcpHandler({ service: serviceDouble });
    const missing = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "record_performance", arguments: { songId: "song-1", clientRequestId: "11111111-1111-4111-8111-111111111111" } } }));
    expect((await missing.json()).result.isError).toBe(true);
    expect(serviceDouble.createPerformance).not.toHaveBeenCalled();

    const readOnly = authInfoForPrincipal({ actor, userId: "user-1", scopes: ["songbook:read"] }, "read-only");
    const denied = await createSongbookMcpHandler({ service: serviceDouble }).fetch(modernRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "record_performance", arguments: { songId: "song-1", clientRequestId: "22222222-2222-4222-8222-222222222222" } } }), { authInfo: readOnly });
    expect((await denied.json()).result.isError).toBe(true);
  });

  it("combines local results with authenticated TJ results and preserves local results on failure", async () => {
    const serviceDouble = service();
    const tj: TjAdapter = { search: vi.fn(async () => tjResult("Song", "all", [{ tjNumber: "123", title: "Song", artist: "Artist", lyricist: "", composer: "", sourceUrl: "https://tj.example/search" }])), lookup: vi.fn() };
    const handler = createSongbookMcpHandler({ service: serviceDouble, tj });
    const response = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_songs", arguments: { query: "Song" } } }), { authInfo });
    const body = await response.json();
    expect(body.result.structuredContent.data).toMatchObject({ query: "Song", saved: [song], tj: { state: "searched", candidates: [{ alreadySaved: true, savedSongId: "song-1" }] } });

    tj.search = vi.fn(async () => { throw Object.assign(new Error("upstream"), { code: "TJ_UPSTREAM_ERROR" }); });
    const failed = await createSongbookMcpHandler({ service: serviceDouble, tj }).fetch(modernRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_songs", arguments: { query: "Song" } } }), { authInfo });
    expect((await failed.json()).result.structuredContent.data).toMatchObject({ saved: [song], tj: { state: "failed", candidates: [], error: { code: "TJ_UPSTREAM_ERROR" } } });
  });

  it("keeps anonymous search local and blocks TJ for authenticated principals without read scope", async () => {
    const serviceDouble = service();
    const search = vi.fn(async () => ({ query: "Song", searchType: "all" as const, nation: "" as const, page: 1, pageSize: 15, hasMore: false, candidates: [], sourceUrl: "https://tj.example/search" }));
    const handler = createSongbookMcpHandler({ service: serviceDouble, tj: { search, lookup: vi.fn() } });
    const anonymous = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "search_songs", arguments: { query: "Song" } } }));
    expect((await anonymous.json()).result.structuredContent.data.tj.state).toBe("skipped_anonymous");
    expect(search).not.toHaveBeenCalled();

    const noRead = authInfoForPrincipal({ actor, userId: "user-1", scopes: ["songbook:write"] }, "write-only");
    const denied = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "search_songs", arguments: { query: "Song" } } }), { authInfo: noRead });
    expect((await denied.json()).result.structuredContent).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(search).not.toHaveBeenCalled();
  });

  it("selects numeric TJ search and honors includeTj=false", async () => {
    const serviceDouble = service();
    const search = vi.fn(async () => tjResult("123", "number"));
    const handler = createSongbookMcpHandler({ service: serviceDouble, tj: { search, lookup: vi.fn() } });
    const numeric = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "search_songs", arguments: { query: "123" } } }), { authInfo });
    expect((await numeric.json()).result.structuredContent.data.tj.searchType).toBe("number");
    const disabled = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "search_songs", arguments: { query: "Song", includeTj: false } } }), { authInfo });
    expect((await disabled.json()).result.structuredContent.data.tj.state).toBe("disabled_by_input");
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("validates keySelection and maps song id aliases through shared schemas", async () => {
    const serviceDouble = service();
    const handler = createSongbookMcpHandler({ service: serviceDouble });
    const response = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "record_performance", arguments: { songId: "song-1", keySelection: { baseMode: "original", offset: 0 }, clientRequestId: "33333333-3333-4333-8333-333333333333" } } }), { authInfo });
    expect((await response.json()).result.structuredContent.ok).toBe(true);
    const update = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "update_song", arguments: { songId: "song-1", title: "Updated", expectedVersion: 1, clientRequestId: "44444444-4444-4444-8444-444444444444" } } }), { authInfo });
    expect((await update.json()).result.structuredContent.ok).toBe(true);
    expect(serviceDouble.updateSong).toHaveBeenCalledWith(actor, expect.objectContaining({ id: "song-1", title: "Updated" }));
    const deletion = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "delete_song", arguments: { id: "song-1", expectedVersion: 1, clientRequestId: "55555555-5555-4555-8555-555555555555" } } }), { authInfo });
    expect((await deletion.json()).result.structuredContent.ok).toBe(true);
    expect(serviceDouble.deleteSong).toHaveBeenCalledWith(actor, expect.objectContaining({ id: "song-1", expectedVersion: 1 }));
    const manual = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "create_song", arguments: { title: "Manual", artist: "Artist", clientRequestId: "66666666-6666-4666-8666-666666666666" } } }), { authInfo });
    expect((await manual.json()).result.structuredContent.ok).toBe(true);
    expect(serviceDouble.createSongOutcome).toHaveBeenCalledWith(actor, expect.objectContaining({ title: "Manual", artist: "Artist" }));
    const fromTj = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "create_song", arguments: { tjCandidate: { tjNumber: "777", title: "TJ song", artist: "TJ artist", sourceUrl: "https://tj.example/777" }, clientRequestId: "77777777-7777-4777-8777-777777777777" } } }), { authInfo });
    expect((await fromTj.json()).result.structuredContent.ok).toBe(true);
    expect(serviceDouble.createTjSong).toHaveBeenCalledWith(actor, expect.objectContaining({ tjNumber: "777" }), "77777777-7777-4777-8777-777777777777");
    const invalid = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "create_song", arguments: { title: "Missing artist", clientRequestId: "88888888-8888-4888-8888-888888888888" } } }), { authInfo });
    expect((await invalid.json()).result.isError).toBe(true);
  });
});
