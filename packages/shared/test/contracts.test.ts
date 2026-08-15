import { describe, expect, it } from "vitest";
import {
  apiFailureSchema,
  apiRouteContractSchema,
  apiSuccessSchema,
  bearerMcpMountOptionsSchema,
  conflictDetailsSchema,
  mcpNegotiationSchema,
  mcpScopeSetSchema,
  performanceCreateRequestSchema,
  songCreateRequestSchema,
  songUpdateRequestSchema
} from "../src/contracts.js";
import { publicDataSchema } from "../src/schemas.js";

const serverTime = "2026-08-13T08:00:00.000Z";

describe("single-server contracts", () => {
  it("accepts the shared success and failure envelopes", () => {
    expect(apiSuccessSchema(publicDataSchema).parse({
      ok: true,
      data: { songs: [], serverVersion: "1", updatedAt: serverTime },
      error: null,
      requestId: "request-1",
      serverTime
    }).ok).toBe(true);
    expect(apiFailureSchema.parse({
      ok: false,
      data: null,
      error: { code: "CONFLICT", message: "version conflict", details: null },
      requestId: "request-2",
      serverTime
    }).error?.code).toBe("CONFLICT");
  });

  it("keeps route authentication explicit", () => {
    expect(apiRouteContractSchema.parse({ method: "GET", path: "/api/catalog", authentication: "anonymous" }).authentication).toBe("anonymous");
    expect(apiRouteContractSchema.parse({ method: "DELETE", path: "/api/songs/:id/delete", authentication: "allowed-session" }).authentication).toBe("allowed-session");
  });

  it("requires UUID request keys and expected versions for updates", () => {
    const validId = "00000000-0000-4000-8000-000000000001";
    expect(performanceCreateRequestSchema.parse({ songId: "song-1", clientRequestId: validId }).clientRequestId).toBe(validId);
    expect(songCreateRequestSchema.safeParse({ title: "Song", artist: "Artist" }).success).toBe(false);
    expect(songCreateRequestSchema.safeParse({ title: "Song", artist: "Artist", clientRequestId: "retry-1" }).success).toBe(false);
    expect(songCreateRequestSchema.parse({ title: "Song", artist: "Artist", clientRequestId: validId }).clientRequestId).toBe(validId);
    expect(songUpdateRequestSchema.safeParse({ id: "song-1", expectedVersion: 2, clientRequestId: validId }).success).toBe(true);
    expect(songUpdateRequestSchema.safeParse({ id: "song-1", expectedVersion: 2, clientRequestId: "retry-1" }).success).toBe(false);
    expect(conflictDetailsSchema.parse({ reason: "version-mismatch", currentVersion: 3, requestVersion: 2 }).reason).toBe("version-mismatch");
  });

  it("models stateless MCP negotiation and bearer audience validation", async () => {
    expect(mcpScopeSetSchema.parse(["songbook:read", "songbook:read"])).toEqual(["songbook:read"]);
    expect(mcpNegotiationSchema.parse({ requestedRevision: "2026-07-28", negotiatedRevision: "2026-07-28", stateless: true }).stateless).toBe(true);
    const options = bearerMcpMountOptionsSchema.parse({
      path: "/mcp",
      audience: "songbook-mcp",
      bearerOnly: true,
      stateless: true,
      validateAudience: async (token: string) => token === "ok"
    });
    await expect(options.validateAudience("ok")).resolves.toBe(true);
  });
});
