import { createMcpHandler, McpServer, type AuthInfo, type McpRequestContext } from "@modelcontextprotocol/server";
import type { RequestActor, SongbookService } from "@songbook/server-core";
import type { McpScope, McpProtocolRevision, BearerMcpMountOptions } from "@songbook/shared";
import { z } from "zod/v4";

export interface StatelessMcpContract {
  revision: McpProtocolRevision;
  scopes: McpScope[];
  mount: BearerMcpMountOptions;
}

export interface McpVerifiedPrincipal {
  actor: RequestActor;
  userId: string;
  scopes: McpScope[];
}

export interface SongbookMcpHandlerOptions {
  service: SongbookService;
}

export const mcpPackage = "@songbook/mcp" as const;

export const mcpContract: StatelessMcpContract = {
  revision: "2026-07-28",
  scopes: ["songbook:read", "songbook:write", "songbook:admin"],
  mount: {
    path: "/mcp",
    audience: "songbook-mcp",
    bearerOnly: true,
    stateless: true,
    validateAudience: () => false
  }
};

const catalogInput = z.object({});
const searchInput = z.object({
  query: z.string().trim().max(200).default(""),
  limit: z.number().int().positive().max(100).default(25)
});
const getSongInput = z.object({ id: z.string().min(1).max(200) });
const performanceInput = z.object({
  songId: z.string().min(1).max(200),
  performedAt: z.string().datetime({ offset: true }).optional(),
  memo: z.string().trim().max(1000).default(""),
  clientRequestId: z.string().uuid()
});
const cancelInput = z.object({
  performanceId: z.string().min(1).max(200),
  expectedVersion: z.number().int().nonnegative().default(1),
  clientRequestId: z.string().uuid()
});

function principalFromContext(authInfo: AuthInfo | undefined): McpVerifiedPrincipal | null {
  const value = authInfo?.extra?.songbookPrincipal;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<McpVerifiedPrincipal>;
  if (!candidate.actor || typeof candidate.actor !== "object") return null;
  const actor = candidate.actor as Partial<RequestActor>;
  if (typeof actor.email !== "string" || !actor.email) return null;
  if (typeof candidate.userId !== "string" || !candidate.userId) return null;
  if (!Array.isArray(candidate.scopes) || !candidate.scopes.every((scope) => typeof scope === "string")) return null;
  return { actor: { email: actor.email, displayName: typeof actor.displayName === "string" ? actor.displayName : actor.email }, userId: candidate.userId, scopes: candidate.scopes as McpScope[] };
}

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }) }],
    structuredContent: { ok: true, data }
  };
}

function failure(error: unknown) {
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value.code === "string" ? value.code : "INTERNAL_ERROR";
  const message = typeof value.message === "string" ? value.message : "요청을 처리하지 못했어.";
  const data = { ok: false, error: { code, message } };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data
  };
}

function guarded(authInfo: AuthInfo | undefined, scope: McpScope): RequestActor {
  const principal = principalFromContext(authInfo);
  if (!principal) throw Object.assign(new Error("Bearer authentication is required"), { code: "UNAUTHORIZED" });
  if (!principal.scopes.includes(scope)) throw Object.assign(new Error("The token does not grant the requested scope"), { code: "FORBIDDEN" });
  return principal.actor;
}

function registerTools(server: McpServer, service: SongbookService, authInfo: AuthInfo | undefined): void {
  server.registerTool("catalog", {
    title: "Songbook catalog",
    description: "List the current Songbook catalog.",
    inputSchema: catalogInput
  }, async (_input) => {
    try {
      guarded(authInfo, "songbook:read");
      return result(service.catalog());
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("search_songs", {
    title: "Search songs",
    description: "Search saved songs by title, artist, aliases, number, and notes.",
    inputSchema: searchInput
  }, async (input) => {
    try {
      guarded(authInfo, "songbook:read");
      return result(service.search(input.query).slice(0, input.limit));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("get_song", {
    title: "Get song",
    description: "Get one saved song by id.",
    inputSchema: getSongInput
  }, async (input) => {
    try {
      guarded(authInfo, "songbook:read");
      const song = service.catalog().find((candidate) => candidate.id === input.id);
      if (!song) throw Object.assign(new Error("곡을 찾을 수 없어."), { code: "NOT_FOUND" });
      return result(song);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("record_performance", {
    title: "Record performance",
    description: "Record that an allowlisted user sang a song.",
    inputSchema: performanceInput
  }, async (input) => {
    try {
      const actor = guarded(authInfo, "songbook:write");
      const performance = service.createPerformance(actor, {
        songId: input.songId,
        performedAt: input.performedAt,
        keySelection: null,
        memo: input.memo,
        clientRequestId: input.clientRequestId
      });
      return result(performance);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("cancel_performance", {
    title: "Cancel performance",
    description: "Cancel one performance record.",
    inputSchema: cancelInput
  }, async (input) => {
    try {
      const actor = guarded(authInfo, "songbook:write");
      const performance = service.cancelPerformance(actor, input);
      return result(performance);
    } catch (error) {
      return failure(error);
    }
  });
}

/**
 * MCP SDK v2's factory is deliberately per exchange. With no session id
 * generator and the SDK's stateless legacy fallback, every request is
 * independently reconstructible after a process restart.
 */
export function createSongbookMcpHandler(options: SongbookMcpHandlerOptions) {
  return createMcpHandler((context: McpRequestContext) => {
    const server = new McpServer({ name: "songbook", version: "0.1.0" });
    registerTools(server, options.service, context.authInfo);
    return server;
  }, { legacy: "stateless", responseMode: "json" });
}

export function authInfoForPrincipal(principal: McpVerifiedPrincipal, accessToken: string): AuthInfo {
  return {
    token: accessToken,
    clientId: principal.userId,
    scopes: principal.scopes,
    extra: { songbookPrincipal: principal }
  };
}
