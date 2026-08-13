import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSongbookService, openDatabase, type RoleResolver, type SongbookService } from "@songbook/server-core";
import { authInfoForPrincipal, createSongbookMcpHandler, mcpPackage } from "../src/index.js";

const actor = { email: "owner@example.com", displayName: "Owner" };
const authInfo = authInfoForPrincipal({ actor, userId: "user-1", scopes: ["songbook:read", "songbook:write"] }, "token-1");

const roleResolver: RoleResolver = {
  resolve: (candidate) => candidate.email === actor.email ? { email: actor.email, displayName: actor.displayName, role: "owner" } : null
};

function songInput(clientRequestId: string) {
  return {
    tjNumber: "12345", title: "Song", titleReadingKo: "", titleRomanized: "", titleAliases: [], artist: "Artist", artistReadingKo: "", artistAliases: [], country: "", genres: [], originalWork: "", keyCandidates: [], performerIds: [], memo: "", status: "active" as const, youtubeUrl: "", youtubeVideoId: "", isOfficialTjVideo: null, sourceType: "test", sourceReference: "", createdByName: "Owner", updatedByName: "Owner", clientRequestId
  };
}

function service(): SongbookService {
  return {
    catalog: vi.fn(() => [{ id: "song-1", tjNumber: "123", title: "Song", titleReadingKo: "", titleRomanized: "", titleAliases: [], artist: "Artist", artistReadingKo: "", artistAliases: [], country: "", genres: [], originalWork: "", keyCandidates: [], performerIds: [], memo: "", status: "active", youtubeUrl: "", youtubeVideoId: "", isOfficialTjVideo: null, sourceType: "", sourceReference: "", createdByName: "", createdAt: "2026-01-01T00:00:00.000Z", updatedByName: "", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: "", version: 1, lastPerformedAt: "", performanceCount: 0 }]),
    search: vi.fn(() => []),
    createPerformance: vi.fn((_, input) => ({ id: "performance-1", songId: input.songId, performedAt: input.performedAt ?? "2026-01-01T00:00:00.000Z", keySelection: null, memo: input.memo, createdByName: "Owner", createdAt: "2026-01-01T00:00:00.000Z", cancelledAt: "", clientRequestId: input.clientRequestId, version: 1 })),
    cancelPerformance: vi.fn((_, input) => ({ id: input.performanceId, songId: "song-1", performedAt: "2026-01-01T00:00:00.000Z", keySelection: null, memo: "", createdByName: "Owner", createdAt: "2026-01-01T00:00:00.000Z", cancelledAt: "2026-01-01T00:00:00.000Z", clientRequestId: input.clientRequestId, version: 2 })),
    checkDuplicate: vi.fn(() => null),
    createSong: vi.fn(), updateSong: vi.fn(), deleteSong: vi.fn(), performanceStats: vi.fn()
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
  return new Request("https://songbook.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(message)
  });
}

describe("stateless Songbook MCP", () => {
  it("exposes a buildable package boundary", () => {
    expect(mcpPackage).toBe("@songbook/mcp");
  });

  it("answers initialize and tools/list without a session id", async () => {
    const handler = createSongbookMcpHandler({ service: service() });
    const initialize = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, false), { authInfo });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get("mcp-session-id")).toBeNull();
    const listed = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), { authInfo });
    expect(listed.status).toBe(200);
    expect((await listed.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["catalog", "search_songs", "get_song", "record_performance", "cancel_performance"]));
  });

  it("calls a read tool with the authenticated actor closure", async () => {
    const serviceDouble = service();
    const handler = createSongbookMcpHandler({ service: serviceDouble });
    const response = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "catalog", arguments: {} } }), { authInfo });
    expect(response.status).toBe(200);
    expect(serviceDouble.catalog).toHaveBeenCalledTimes(1);
  });

  it("rejects write scope before the service callback", async () => {
    const serviceDouble = service();
    const handler = createSongbookMcpHandler({ service: serviceDouble });
    const readOnly = authInfoForPrincipal({ actor, userId: "user-1", scopes: ["songbook:read"] }, "read-only");
    const response = await handler.fetch(modernRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "record_performance", arguments: { songId: "song-1", clientRequestId: "11111111-1111-4111-8111-111111111111", memo: "" } } }), { authInfo: readOnly });
    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).toBe(true);
    expect(serviceDouble.createPerformance).not.toHaveBeenCalled();
  });

  it("replays one durable write with the same result after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "songbook-mcp-"));
    const filename = join(directory, "songbook.sqlite");
    const seedDatabase = openDatabase({ filename });
    const seedService = createSongbookService(seedDatabase, { roleResolver });
    const song = seedService.createSong(actor, songInput("33333333-3333-4333-8333-333333333333"));
    seedDatabase.close();
    const message = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "record_performance", arguments: { songId: "song-1", clientRequestId: "22222222-2222-4222-8222-222222222222", memo: "" } } };
    message.params.arguments.songId = song.id;
    try {
      const firstDatabase = openDatabase({ filename });
      const first = await createSongbookMcpHandler({ service: createSongbookService(firstDatabase, { roleResolver }) }).fetch(modernRequest(message), { authInfo });
      const firstBody = await first.json();
      firstDatabase.close();
      const secondDatabase = openDatabase({ filename });
      const second = await createSongbookMcpHandler({ service: createSongbookService(secondDatabase, { roleResolver }) }).fetch(modernRequest({ ...message, id: 6 }), { authInfo });
      const secondBody = await second.json();
      expect(secondBody.result.structuredContent).toEqual(firstBody.result.structuredContent);
      expect(secondDatabase.sqlite.prepare("SELECT COUNT(*) AS count FROM performances WHERE client_request_id=?").get("22222222-2222-4222-8222-222222222222")).toEqual({ count: 1 });
      expect(secondDatabase.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE entity_type='performance'").get()).toEqual({ count: 1 });
      secondDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not accept cookie-only or missing bearer context", async () => {
    const handler = createSongbookMcpHandler({ service: service() });
    const request = modernRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "catalog", arguments: {} } });
    const response = await handler.fetch(request);
    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).toBe(true);
  });
});
