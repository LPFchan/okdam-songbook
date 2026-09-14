import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  currentUserSchema,
  favoriteListSchema,
  favoriteSetRequestSchema,
  favoriteSetResultSchema,
  performanceCancelRequestSchema,
  performanceCreateRequestSchema,
  publicDataSchema,
  readingGenerateInputSchema,
  songCreateRequestSchema,
  songDeleteRequestSchema,
  songUpdateRequestSchema,
  tjLookupRequestSchema,
  tjSearchRequestSchema,
  tjSongCandidateSchema,
  type CurrentUser
} from "@songbook/shared";
import type { SongbookDatabase } from "@songbook/server-core";
import {
  createSongbookService,
  DomainError,
  toApiError,
  type RequestActor,
  type RoleResolver,
  type SongbookService,
  type TjAdapter
} from "@songbook/server-core";
import { z } from "zod";
import {
  createCommonAuthRoleResolver,
  type McpAuthAdapter,
  createGatewayMcpAuthAdapter,
  resolveGatewayIdentity,
  mcpBearerChallenge
} from "./auth.js";
import { authInfoForPrincipal, createSongbookMcpHandler, mcpRequiredScopeForBody, mcpToolPolicyFor } from "@songbook/mcp";
import type { ReadingGenerator } from "./reading.js";

export interface BrowserPrincipal extends RequestActor {
  id?: string;
  expiresAt?: string | number | Date;
}

export type BrowserSessionResolver = (request: Request) => Promise<BrowserPrincipal | null>;

export interface ServerAppOptions {
  database: SongbookDatabase;
  origin: string;
  assetsRoot?: string;
  service?: SongbookService;
  roleResolver?: RoleResolver;
  sessionResolver?: BrowserSessionResolver;
  tj?: TjAdapter;
  readingGenerator?: ReadingGenerator;
  mcpAuth?: McpAuthAdapter;
  now?: () => string;
}

export interface ServerApp {
  app: Hono;
  database: SongbookDatabase;
  service: SongbookService;
  mcpAuth: McpAuthAdapter;
}

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/i;
const ANONYMOUS_MCP_METHODS = new Set([
  "initialize",
  "server/discover",
  "ping",
  "tools/list",
  "resources/list",
  "prompts/list",
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
  "notifications/message",
  "notifications/resources/list_changed",
  "notifications/resources/updated",
  "notifications/tools/list_changed",
  "notifications/prompts/list_changed",
  "notifications/roots/list_changed",
  "notifications/tasks/status",
  "notifications/elicitation/complete"
]);

function requestId(c: Context): string {
  return c.req.header("X-Request-Id")?.trim() || crypto.randomUUID();
}

function envelope(c: Context, data: unknown, now: () => string): Response {
  return c.json({ ok: true, data, error: null, requestId: requestId(c), serverTime: now() });
}

function failure(c: Context, error: unknown, now: () => string, status?: number): Response {
  const zodError = error && typeof error === "object" && "flatten" in error && typeof error.flatten === "function";
  const details = zodError ? (error as { flatten: () => unknown }).flatten() : null;
  const mapped = zodError || error instanceof SyntaxError
    ? toApiError(new DomainError("VALIDATION_ERROR", "입력 형식이 올바르지 않아.", details))
    : toApiError(error);
  const codeStatus: Record<string, number> = {
    BAD_REQUEST: 400, VALIDATION_ERROR: 400, UNAUTHORIZED: 401, FORBIDDEN: 403,
    NOT_FOUND: 404, CONFLICT: 409, DUPLICATE_TJ_NUMBER: 409,
    TJ_RATE_LIMITED: 429, RATE_LIMITED: 429,
    AI_NOT_CONFIGURED: 503, EXTERNAL_API_ERROR: 502
  };
  return c.json({ ok: false, data: null, error: mapped, requestId: requestId(c), serverTime: now() }, (status ?? codeStatus[mapped.code] ?? 500) as 500);
}

function jsonBodyRequired(c: Context): Response | null {
  const contentType = c.req.header("Content-Type") || "";
  if (!JSON_MEDIA_TYPE.test(contentType)) {
    return c.json({ ok: false, data: null, error: { code: "BAD_REQUEST", message: "JSON 요청만 지원해.", details: null }, requestId: requestId(c), serverTime: new Date().toISOString() }, 415);
  }
  return null;
}

function sameOrigin(c: Context, origin: string): boolean {
  return c.req.header("Origin") === origin;
}

function hasAuthorizationHeader(c: Context): boolean {
  return c.req.header("Authorization") !== undefined;
}

function validJsonRpcMessage(body: unknown): body is { jsonrpc: "2.0"; method: string; params?: unknown } {
  return Boolean(body && typeof body === "object" && !Array.isArray(body)
    && (body as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && typeof (body as { method?: unknown }).method === "string");
}

function anonymousMcpRequestAllowed(method: string, body: unknown): boolean {
  if (method === "GET" || method === "DELETE") return true;
  if (method !== "POST" || !validJsonRpcMessage(body)) return false;
  if (ANONYMOUS_MCP_METHODS.has(body.method)) return true;
  if (body.method !== "tools/call" || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) return false;
  const name = (body.params as { name?: unknown }).name;
  return typeof name === "string" && mcpToolPolicyFor(name)?.access === "public";
}

function bodyDerivedMcpRequest(request: Request, body: unknown): Request {
  if (!validJsonRpcMessage(body)) return request;
  const headers = new Headers(request.headers);
  headers.set("Mcp-Method", body.method);
  if (body.method === "tools/call" && body.params && typeof body.params === "object" && !Array.isArray(body.params) && typeof (body.params as { name?: unknown }).name === "string") {
    headers.set("Mcp-Name", String((body.params as { name: string }).name));
  } else {
    headers.delete("Mcp-Name");
  }
  return new Request(request, { headers });
}

function etag(value: string): string {
  return `"${createHash("sha256").update(value).digest("hex")}"`;
}

function safeAssetPath(root: string, pathname: string): string | null {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, normalize(relative));
  const base = resolve(root);
  if (candidate !== base && !candidate.startsWith(`${base}/`)) return null;
  return candidate;
}

function contentType(path: string): string {
  return ({
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json"
  } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function staticHeaders(path: string): Record<string, string> {
  const type = contentType(path);
  if (!type.startsWith("text/html")) return { "Content-Type": type };
  return {
    "Content-Type": type,
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY"
  };
}

function staticResponse(root: string | undefined, pathname: string): Response | null {
  if (!root) return null;
  if (pathname.startsWith("/api/") || pathname === "/api" || pathname.startsWith("/mcp") || pathname.startsWith("/.well-known/")) return null;
  const direct = safeAssetPath(root, pathname);
  if (direct && existsSync(direct) && statSync(direct).isFile()) return new Response(readFileSync(direct), { headers: staticHeaders(direct) });
  const fallback = safeAssetPath(root, "/index.html");
  if (fallback && existsSync(fallback) && statSync(fallback).isFile()) return new Response(readFileSync(fallback), { headers: staticHeaders(fallback) });
  return null;
}

function currentUser(principal: BrowserPrincipal, roleResolver: RoleResolver): CurrentUser | null {
  const resolved = roleResolver.resolve(principal);
  if (!resolved) return null;
  return currentUserSchema.parse({ subject: resolved.subject, email: resolved.email, displayName: resolved.displayName, role: resolved.role });
}

export function createConfiguredServer(options: Omit<ServerAppOptions, "roleResolver" | "sessionResolver" | "mcpAuth">): ServerApp {
  return createServerApp({
    ...options,
    roleResolver: createCommonAuthRoleResolver(),
    sessionResolver: async (request) => {
      const identity = resolveGatewayIdentity(request);
      return identity ? { id: identity.sub, subject: `auth.lost.plus:${identity.sub}`, email: identity.email, displayName: identity.name } : null;
    },
    mcpAuth: createGatewayMcpAuthAdapter()
  });
}

export function createServerApp(options: ServerAppOptions): ServerApp {
  const now = options.now ?? (() => new Date().toISOString());
  const roleResolver = options.roleResolver ?? { resolve: () => null };
  const service = options.service ?? createSongbookService(options.database, { roleResolver, now });
  const sessionResolver: BrowserSessionResolver = options.sessionResolver ?? (async () => null);
  const mcpAuth = options.mcpAuth ?? {
    verifyRequest: async () => ({ ok: false as const, response: mcpBearerChallenge(true) })
  };
  const mcpHandler = createSongbookMcpHandler({ service, tj: options.tj });
  const app = new Hono();

  const protectBrowser = async (c: Context): Promise<BrowserPrincipal | Response> => {
    if (hasAuthorizationHeader(c)) return failure(c, new DomainError("UNAUTHORIZED", "브라우저 세션이 필요해."), now);
    const principal = await sessionResolver(c.req.raw);
    const user = principal && currentUser(principal, roleResolver);
    if (!principal || !user) return failure(c, new DomainError("UNAUTHORIZED", "로그인 또는 허용된 계정이 필요해."), now);
    const expectedSubject = c.req.header("X-Songbook-Owner-Subject");
    if (expectedSubject && user.subject !== expectedSubject) {
      return failure(c, new DomainError("FORBIDDEN", "다른 계정에서 만든 요청은 실행할 수 없어."), now);
    }
    return principal;
  };

  const mutate = async (
    c: Context,
    fn: (actor: BrowserPrincipal) => Promise<unknown> | unknown,
    requireOwnerSubject = false
  ): Promise<Response> => {
    const bodyError = jsonBodyRequired(c);
    if (bodyError) return bodyError;
    if (!sameOrigin(c, options.origin)) return failure(c, new DomainError("FORBIDDEN", "같은 출처 요청만 허용해."), now);
    if (requireOwnerSubject && !c.req.header("X-Songbook-Owner-Subject")) {
      return failure(c, new DomainError("FORBIDDEN", "요청을 만든 계정을 확인할 수 없어."), now);
    }
    const principal = await protectBrowser(c);
    if (principal instanceof Response) return principal;
    try { return envelope(c, await fn(principal), now); } catch (error) { return failure(c, error, now); }
  };

  app.get("/healthz", (c) => {
    try {
      options.database.sqlite.prepare("SELECT 1 AS ok").get();
      const name = `songbook_health_${crypto.randomUUID().replaceAll("-", "")}`;
      options.database.sqlite.exec(`SAVEPOINT ${name}; CREATE TEMP TABLE ${name}(ok INTEGER); INSERT INTO ${name}(ok) VALUES (1); ROLLBACK TO ${name}; RELEASE ${name};`);
      return c.json({ ok: true });
    } catch { return c.json({ ok: false }, 503); }
  });

  app.get("/api/catalog", (c) => {
    const songs = service.catalog();
    const updatedAt = songs.reduce((latest, song) => song.updatedAt > latest ? song.updatedAt : latest, "");
    const revision = createHash("sha256").update(JSON.stringify(songs)).digest("hex").slice(0, 16);
    const data = publicDataSchema.parse({ songs, serverVersion: revision, updatedAt: updatedAt || "1970-01-01T00:00:00.000Z" });
    const body = JSON.stringify(data);
    const tag = etag(body);
    const incomingEtag = c.req.raw.headers.get("If-None-Match") || c.req.header("If-None-Match");
    if (incomingEtag?.replace(/^W\//, "") === tag || incomingEtag === tag) return new Response(null, { status: 304, headers: { ETag: tag } });
    const response = envelope(c, data, now);
    response.headers.set("ETag", tag);
    response.headers.set("Cache-Control", "private, no-cache");
    return response;
  });

  app.get("/api/me", async (c) => {
    const principal = await protectBrowser(c);
    if (principal instanceof Response) return principal;
    const user = currentUser(principal, roleResolver);
    return user ? envelope(c, user, now) : failure(c, new DomainError("UNAUTHORIZED", "허용된 계정이 필요해."), now);
  });

  app.get("/api/session", async (c) => {
    if (hasAuthorizationHeader(c)) return failure(c, new DomainError("UNAUTHORIZED", "브라우저 세션이 필요해."), now);
    const principal = await sessionResolver(c.req.raw);
    if (!principal) return failure(c, new DomainError("UNAUTHORIZED", "로그인 세션이 없어."), now);
    const user = currentUser(principal, roleResolver);
    if (!user) return failure(c, new DomainError("UNAUTHORIZED", "허용된 계정이 필요해."), now);
    return envelope(c, { user: { id: principal.id ?? principal.email, email: user.email, name: user.displayName, role: user.role }, session: { id: principal.id ?? principal.email, expiresAt: principal.expiresAt ?? now() } }, now);
  });

  app.get("/api/favorites", async (c) => {
    const principal = await protectBrowser(c);
    if (principal instanceof Response) return principal;
    try {
      const user = currentUser(principal, roleResolver)!;
      const response = envelope(c, favoriteListSchema.parse({ ownerSubject: user.subject, songIds: service.favoriteSongIds(principal) }), now);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    } catch (error) {
      return failure(c, error, now);
    }
  });
  app.post("/api/favorites/:songId", (c) => mutate(c, async (actor) => {
    const parsed = favoriteSetRequestSchema.safeParse({ ...(await c.req.json()), songId: c.req.param("songId") });
    if (!parsed.success) throw parsed.error;
    return favoriteSetResultSchema.parse(service.setFavorite(actor, parsed.data));
  }, true));

  app.post("/api/performances", (c) => mutate(c, async (actor) => {
    const parsed = performanceCreateRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return service.createPerformance(actor, parsed.data);
  }, true));
  app.delete("/api/performances/:id", (c) => mutate(c, async (actor) => {
    const parsed = performanceCancelRequestSchema.safeParse({ ...(await c.req.json()), performanceId: c.req.param("id") });
    if (!parsed.success) throw parsed.error;
    return service.cancelPerformance(actor, { ...parsed.data, expectedVersion: parsed.data.expectedVersion ?? 1 });
  }, true));
  app.post("/api/songs", (c) => mutate(c, async (actor) => {
    const parsed = songCreateRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return service.createSong(actor, parsed.data);
  }, true));
  app.patch("/api/songs/:id", (c) => mutate(c, async (actor) => {
    const parsed = songUpdateRequestSchema.safeParse({ ...(await c.req.json()), id: c.req.param("id") });
    if (!parsed.success) throw parsed.error;
    return service.updateSong(actor, parsed.data);
  }, true));
  app.delete("/api/songs/:id/delete", (c) => mutate(c, async (actor) => {
    const parsed = songDeleteRequestSchema.safeParse({ ...(await c.req.json()), songId: c.req.param("id") });
    if (!parsed.success) throw parsed.error;
    return service.deleteSong(actor, { id: parsed.data.songId, expectedVersion: parsed.data.expectedVersion, clientRequestId: parsed.data.clientRequestId });
  }, true));

  app.post("/api/readings/generate", (c) => mutate(c, async () => {
    if (!options.readingGenerator) throw new DomainError("AI_NOT_CONFIGURED", "독음 자동 생성이 설정되지 않았어. 수동으로 입력해줘.");
    const parsed = readingGenerateInputSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return options.readingGenerator.generate(parsed.data);
  }, true));

  app.post("/api/tj/search", (c) => mutate(c, async () => {
    if (!options.tj) throw new DomainError("TJ_UPSTREAM_ERROR", "TJ 연결이 설정되지 않았어.");
    const parsed = tjSearchRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return options.tj.search(parsed.data);
  }));
  app.post("/api/tj/lookup", (c) => mutate(c, async () => {
    if (!options.tj) throw new DomainError("TJ_UPSTREAM_ERROR", "TJ 연결이 설정되지 않았어.");
    const parsed = tjLookupRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return options.tj.lookup(parsed.data);
  }));
  app.post("/api/tj/add", (c) => mutate(c, async (actor) => {
    const body = await c.req.json();
    const parsed = z.object({ candidate: z.unknown(), clientRequestId: z.string().uuid() }).safeParse(body);
    if (!parsed.success) throw parsed.error;
    const candidate = tjSongCandidateSchema.safeParse(parsed.data.candidate);
    if (!candidate.success) throw candidate.error;
    return service.createTjSong(actor, candidate.data, parsed.data.clientRequestId);
  }, true));

  app.all("/mcp", async (c) => {
    const request = c.req.raw;
    const body = request.method === "POST" ? await request.clone().json().catch(() => null) : null;
    const handlerRequest = bodyDerivedMcpRequest(request, body);
    if (resolveGatewayIdentity(request) === null) {
      if (!anonymousMcpRequestAllowed(request.method, body)) return mcpBearerChallenge();
      return mcpHandler.fetch(handlerRequest, { parsedBody: body ?? undefined });
    }
    const requiredScope = mcpRequiredScopeForBody(body);
    const checked = await mcpAuth.verifyRequest(request, requiredScope ? [requiredScope] : []);
    if (!checked.ok) return checked.response;
    if (!roleResolver.resolve(checked.principal.actor)) return mcpBearerChallenge(true);
    return mcpHandler.fetch(handlerRequest, {
      authInfo: authInfoForPrincipal({ ...checked.principal, scopes: checked.token.scopes }, checked.token.accessToken),
      parsedBody: body ?? undefined
    });
  });

  app.all("*", (c) => {
    const staticFile = staticResponse(options.assetsRoot, new URL(c.req.url).pathname);
    return staticFile ?? c.notFound();
  });
  return { app, database: options.database, service, mcpAuth };
}

export { safeAssetPath };
