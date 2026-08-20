import { createMcpHandler, McpServer, type AuthInfo, type McpRequestContext } from "@modelcontextprotocol/server";
import {
  performanceCancelRequestSchema,
  performanceCreateRequestSchema,
  songCreateRequestSchema,
  songDeleteRequestSchema,
  songUpdateRequestSchema,
  tjSongCandidateSchema,
  type McpScope,
  type McpProtocolRevision,
  type OptionalOAuthMcpMountOptions
} from "@songbook/shared";
import type { RequestActor, SongbookService, TjAdapter } from "@songbook/server-core";
import { combinedSongSearch } from "@songbook/server-core";
import { z } from "zod/v4";

export interface StatelessMcpContract {
  revision: McpProtocolRevision;
  scopes: McpScope[];
  mount: OptionalOAuthMcpMountOptions;
}

export interface McpVerifiedPrincipal {
  actor: RequestActor;
  userId: string;
  scopes: McpScope[];
}

export interface SongbookMcpHandlerOptions {
  service: SongbookService;
  tj?: TjAdapter;
}

export type McpToolAccess = "public" | "write";

export interface McpToolPolicyEntry {
  readonly access: McpToolAccess;
  readonly requiredScope: McpScope | null;
}

export const mcpToolPolicy = {
  catalog: { access: "public", requiredScope: null },
  search_songs: { access: "public", requiredScope: "songbook:read" },
  get_song: { access: "public", requiredScope: null },
  record_performance: { access: "write", requiredScope: "songbook:write" },
  cancel_performance: { access: "write", requiredScope: "songbook:write" },
  create_song: { access: "write", requiredScope: "songbook:write" },
  update_song: { access: "write", requiredScope: "songbook:write" },
  delete_song: { access: "write", requiredScope: "songbook:write" }
} as const satisfies Record<string, McpToolPolicyEntry>;

export type McpToolName = keyof typeof mcpToolPolicy;

export const mcpPackage = "@songbook/mcp" as const;

export const mcpContract: StatelessMcpContract = {
  revision: "2026-07-28",
  scopes: ["songbook:read", "songbook:write"],
  mount: {
    authentication: "optional-oauth",
    path: "/mcp",
    audience: "songbook-mcp",
    stateless: true
  }
};

export function mcpToolPolicyFor(name: string): McpToolPolicyEntry | null {
  return Object.hasOwn(mcpToolPolicy, name) ? mcpToolPolicy[name as McpToolName] : null;
}

export function mcpRequiredScopeForBody(body: unknown): McpScope | null | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const message = body as { method?: unknown; params?: unknown };
  if (message.method !== "tools/call" || !message.params || typeof message.params !== "object" || Array.isArray(message.params)) return null;
  const name = (message.params as { name?: unknown }).name;
  if (typeof name !== "string") return undefined;
  return mcpToolPolicyFor(name)?.requiredScope;
}

const catalogInput = z.object({
  limit: z.number().int().positive().max(100).default(50),
  cursor: z.string().regex(/^\d{1,6}$/u).optional()
});

const searchInput = z.object({
  query: z.string().max(200).default(""),
  limit: z.number().int().positive().max(100).default(25),
  includeTj: z.boolean().default(true)
});

const getSongInput = z.object({ id: z.string().min(1).max(200) });

const keySelectionInput = z.object({
  id: z.string().min(1),
  baseMode: z.enum(["original", "male", "female", "custom"]),
  offset: z.number().int().min(-12).max(12),
  label: z.string().trim().max(40).default(""),
  memo: z.string().trim().max(500).default(""),
  isPrimary: z.boolean().default(false)
}).partial().nullable().default(null);

const performanceInput = z.object({
  songId: z.string().min(1).max(200),
  performedAt: z.string().datetime({ offset: true }).optional(),
  keySelection: keySelectionInput,
  memo: z.string().trim().max(1000).default(""),
  clientRequestId: z.string().uuid()
});

const cancelInput = z.object({
  performanceId: z.string().min(1).max(200),
  expectedVersion: z.number().int().nonnegative().default(1),
  clientRequestId: z.string().uuid()
});

const tjCandidateInput = z.object({
  tjNumber: z.string().regex(/^\d+$/u),
  title: z.string().trim().min(1).max(300),
  artist: z.string().trim().min(1).max(300),
  lyricist: z.string().trim().max(300).default(""),
  composer: z.string().trim().max(300).default(""),
  sourceUrl: z.string().url()
});

const keyCandidateInput = z.object({
  id: z.string().min(1),
  baseMode: z.enum(["original", "male", "female", "custom"]),
  offset: z.number().int().min(-12).max(12),
  label: z.string().trim().max(40).default(""),
  memo: z.string().trim().max(500).default(""),
  isPrimary: z.boolean().default(false)
});

const songFields = {
  tjNumber: z.string().trim().regex(/^\d*$/u).default(""),
  title: z.string().trim().min(1).max(300).optional(),
  titleReadingKo: z.string().trim().max(300).default(""),
  titleRomanized: z.string().trim().max(300).default(""),
  titleAliases: z.array(z.string().trim().max(160)).default([]),
  artist: z.string().trim().min(1).max(300).optional(),
  artistReadingKo: z.string().trim().max(300).default(""),
  artistAliases: z.array(z.string().trim().max(160)).default([]),
  country: z.string().trim().max(80).default(""),
  genres: z.array(z.string().trim().max(80)).default([]),
  originalWork: z.string().trim().max(200).default(""),
  keyCandidates: z.array(keyCandidateInput).default([]),
  performerIds: z.array(z.enum(["marie", "seongwook", "yeowool"])).default([]),
  memo: z.string().trim().max(2000).default(""),
  status: z.enum(["active", "favorite", "practicing", "hold", "deletion_candidate", "deleted"]).default("active"),
  youtubeUrl: z.string().trim().url().or(z.literal("")).default(""),
  youtubeVideoId: z.string().trim().max(40).default(""),
  isOfficialTjVideo: z.boolean().nullable().default(null),
  sourceType: z.string().trim().max(80).default(""),
  sourceReference: z.string().trim().max(300).default("")
};

const createSongInput = z.object({
  ...songFields,
  clientRequestId: z.string().uuid(),
  tjCandidate: tjCandidateInput.optional()
}).refine((value) => Boolean(value.tjCandidate || (value.title && value.artist)), {
  message: "title and artist are required unless tjCandidate is supplied"
});

const updateSongInput = z.object({
  tjNumber: songFields.tjNumber.optional(),
  title: songFields.title,
  titleReadingKo: songFields.titleReadingKo.optional(),
  titleRomanized: songFields.titleRomanized.optional(),
  titleAliases: songFields.titleAliases.optional(),
  artist: songFields.artist,
  artistReadingKo: songFields.artistReadingKo.optional(),
  artistAliases: songFields.artistAliases.optional(),
  country: songFields.country.optional(),
  genres: songFields.genres.optional(),
  originalWork: songFields.originalWork.optional(),
  keyCandidates: songFields.keyCandidates.optional(),
  performerIds: songFields.performerIds.optional(),
  memo: songFields.memo.optional(),
  status: songFields.status.optional(),
  youtubeUrl: songFields.youtubeUrl.optional(),
  youtubeVideoId: songFields.youtubeVideoId.optional(),
  isOfficialTjVideo: songFields.isOfficialTjVideo.optional(),
  sourceType: songFields.sourceType.optional(),
  sourceReference: songFields.sourceReference.optional(),
  id: z.string().min(1).max(200).optional(),
  songId: z.string().min(1).max(200).optional(),
  expectedVersion: z.number().int().nonnegative(),
  clientRequestId: z.string().uuid()
}).refine((value) => Boolean(value.id || value.songId), { message: "id or songId is required" });

const deleteSongInput = z.object({
  id: z.string().min(1).max(200).optional(),
  songId: z.string().min(1).max(200).optional(),
  expectedVersion: z.number().int().nonnegative(),
  clientRequestId: z.string().uuid()
}).refine((value) => Boolean(value.id || value.songId), { message: "id or songId is required" });

function principalFromContext(authInfo: AuthInfo | undefined): McpVerifiedPrincipal | null {
  const value = authInfo?.extra?.songbookPrincipal;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<McpVerifiedPrincipal>;
  if (!candidate.actor || typeof candidate.actor !== "object") return null;
  const actor = candidate.actor as Partial<RequestActor>;
  if (typeof actor.email !== "string" || !actor.email) return null;
  if (typeof candidate.userId !== "string" || !candidate.userId) return null;
  if (!Array.isArray(candidate.scopes) || !candidate.scopes.every((scope) => typeof scope === "string")) return null;
  return {
    actor: { email: actor.email, displayName: typeof actor.displayName === "string" ? actor.displayName : actor.email },
    userId: candidate.userId,
    scopes: candidate.scopes as McpScope[]
  };
}

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }) }],
    structuredContent: { ok: true, data }
  };
}

function failure(error: unknown) {
  const value = error as { code?: unknown; message?: unknown; issues?: unknown };
  const validation = Array.isArray(value?.issues);
  const code = validation ? "VALIDATION_ERROR" : typeof value.code === "string" ? value.code : "INTERNAL_ERROR";
  const message = validation ? "입력 형식이 올바르지 않아." : typeof value.message === "string" ? value.message : "요청을 처리하지 못했어.";
  const data = { ok: false, error: { code, message } };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data
  };
}

function validationError(error: { issues: unknown }): never {
  throw Object.assign(new Error("입력 형식이 올바르지 않아."), { code: "VALIDATION_ERROR", issues: error.issues });
}

function sharedParse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) validationError(parsed.error);
  return parsed.data;
}

function guarded(authInfo: AuthInfo | undefined, toolName: McpToolName): McpVerifiedPrincipal | null {
  const policy = mcpToolPolicy[toolName];
  const principal = principalFromContext(authInfo);
  if (!principal) {
    if (policy.access === "public") return null;
    throw Object.assign(new Error("Bearer authentication is required"), { code: "UNAUTHORIZED" });
  }
  if (policy.requiredScope && !principal.scopes.includes(policy.requiredScope)) {
    throw Object.assign(new Error("The token does not grant the requested scope"), { code: "FORBIDDEN" });
  }
  return principal;
}

function registerTools(server: McpServer, options: SongbookMcpHandlerOptions, authInfo: AuthInfo | undefined): void {
  server.registerTool("catalog", {
    title: "Songbook catalog",
    description: "List the current public Songbook catalog.",
    inputSchema: catalogInput
  }, async (input) => {
    try {
      guarded(authInfo, "catalog");
      const songs = options.service.catalog();
      const offset = input.cursor ? Number(input.cursor) : 0;
      const page = songs.slice(offset, offset + input.limit);
      return result({ songs: page, total: songs.length, nextCursor: offset + page.length < songs.length ? String(offset + page.length) : null });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("search_songs", {
    title: "Search songs",
    description: "Search saved songs and, for eligible authenticated queries, continue through TJ.",
    inputSchema: searchInput
  }, async (input) => {
    try {
      const principal = guarded(authInfo, "search_songs");
      return result(await combinedSongSearch({
        service: options.service,
        tj: options.tj,
        query: input.query,
        limit: input.limit,
        includeTj: input.includeTj,
        authenticated: Boolean(principal)
      }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("get_song", {
    title: "Get song",
    description: "Get one active public saved song by id.",
    inputSchema: getSongInput
  }, async (input) => {
    try {
      guarded(authInfo, "get_song");
      const song = options.service.getSong(input.id);
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
      const principal = guarded(authInfo, "record_performance");
      if (!principal) throw Object.assign(new Error("Bearer authentication is required"), { code: "UNAUTHORIZED" });
      const parsed = sharedParse(performanceCreateRequestSchema, { ...input, keySelection: input.keySelection });
      return result(options.service.createPerformance(principal.actor, {
        songId: parsed.songId,
        performedAt: parsed.performedAt,
        keySelection: parsed.keySelection,
        memo: parsed.memo,
        clientRequestId: parsed.clientRequestId
      }));
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
      const principal = guarded(authInfo, "cancel_performance");
      if (!principal) throw Object.assign(new Error("Bearer authentication is required"), { code: "UNAUTHORIZED" });
      const parsed = sharedParse(performanceCancelRequestSchema, input);
      return result(options.service.cancelPerformance(principal.actor, {
        performanceId: parsed.performanceId,
        expectedVersion: parsed.expectedVersion ?? 1,
        clientRequestId: parsed.clientRequestId
      }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("create_song", {
    title: "Create song",
    description: "Create a manual song or add a TJ candidate with a structured duplicate outcome.",
    inputSchema: createSongInput
  }, async (input) => {
    try {
      const principal = guarded(authInfo, "create_song");
      if (!principal) throw Object.assign(new Error("Bearer authentication is required"), { code: "UNAUTHORIZED" });
      if (input.tjCandidate) {
        const candidate = sharedParse(tjSongCandidateSchema, input.tjCandidate);
        return result(options.service.createTjSong(principal.actor, candidate, input.clientRequestId));
      }
      const parsed = sharedParse(songCreateRequestSchema, {
        ...input,
        title: input.title,
        artist: input.artist,
        clientRequestId: input.clientRequestId,
        createdByName: principal.actor.displayName ?? principal.actor.email,
        updatedByName: principal.actor.displayName ?? principal.actor.email
      });
      return result(options.service.createSongOutcome(principal.actor, parsed));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("update_song", {
    title: "Update song",
    description: "Update one saved song with optimistic version checking.",
    inputSchema: updateSongInput
  }, async (input) => {
    try {
      const principal = guarded(authInfo, "update_song");
      if (!principal) throw Object.assign(new Error("Bearer authentication is required"), { code: "UNAUTHORIZED" });
      const id = input.id ?? input.songId;
      const parsed = sharedParse(songUpdateRequestSchema, {
        ...input,
        id,
        clientRequestId: input.clientRequestId,
        updatedByName: principal.actor.displayName ?? principal.actor.email
      });
      return result(options.service.updateSong(principal.actor, parsed));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("delete_song", {
    title: "Delete song",
    description: "Permanently delete one saved song with optimistic version checking.",
    inputSchema: deleteSongInput
  }, async (input) => {
    try {
      const principal = guarded(authInfo, "delete_song");
      if (!principal) throw Object.assign(new Error("Bearer authentication is required"), { code: "UNAUTHORIZED" });
      const inputParsed = sharedParse(deleteSongInput, input);
      const parsed = sharedParse(songDeleteRequestSchema, {
        songId: inputParsed.id ?? inputParsed.songId ?? "",
        expectedVersion: inputParsed.expectedVersion,
        clientRequestId: inputParsed.clientRequestId
      });
      return result(options.service.deleteSong(principal.actor, {
        id: parsed.songId,
        expectedVersion: parsed.expectedVersion,
        clientRequestId: parsed.clientRequestId
      }));
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
    registerTools(server, options, context.authInfo);
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
