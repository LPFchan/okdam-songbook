import { sha256Hex } from "@songbook/server-core";
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
import type { SongbookDatabaseBase } from "@songbook/server-core";
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
import { authInfoForPrincipal, createSongbookMcpHandler, mcpRequiredScopeForBody } from "@songbook/mcp";
import type { ReadingGenerator } from "./reading.js";

export interface BrowserPrincipal extends RequestActor {
  id?: string;
  expiresAt?: string | number | Date;
}

export type BrowserSessionResolver = (request: Request) => Promise<BrowserPrincipal | null>;

export interface ServerAppOptions {
  database: SongbookDatabaseBase;
  origin: string;
  assetsRoot?: string;
  service?: SongbookService;
  roleResolver?: RoleResolver;
  sessionResolver?: BrowserSessionResolver;
  tj?: TjAdapter;
  readingGenerator?: ReadingGenerator;
  mcpAuth?: McpAuthAdapter;
  mcpMaxBodyBytes?: number;
  mcpMaxInflightBodies?: number;
  mcpBodyTimeoutMs?: number;
  now?: () => string;
}

export interface ServerApp {
  app: Hono;
  database: SongbookDatabaseBase;
  service: SongbookService;
  mcpAuth: McpAuthAdapter;
}

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/i;
const DEFAULT_MCP_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MCP_MAX_INFLIGHT_BODIES = 4;
const DEFAULT_MCP_BODY_TIMEOUT_MS = 30_000;

class McpBodyTooLarge extends Error {}
class McpBodyTimedOut extends Error {}

class McpBodyGate {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("MCP body concurrency must be a positive integer");
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) this.available -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${label} must be a positive integer`);
  return resolved;
}

function rejectDeclaredMcpBody(request: Request, limit: number): boolean {
  const value = request.headers.get("Content-Length");
  if (value === null) return false;
  if (!/^\d+$/.test(value)) return true;
  const length = Number(value);
  return !Number.isSafeInteger(length) || length > limit;
}

async function readMcpBody(request: Request, limit: number, timeoutMs: number): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const consume = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel();
        throw new McpBodyTooLarge();
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body.buffer;
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel();
      reject(new McpBodyTimedOut());
    }, timeoutMs);
  });
  try {
    return await Promise.race([consume, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function replayRequest(request: Request, body: ArrayBuffer): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal
  });
}

function mcpBodyFailure(status: 408 | 413, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

async function settledMcpResponse(response: Response | Promise<Response>): Promise<Response> {
  const source = await response;
  const body = await source.arrayBuffer();
  return new Response(body, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers
  });
}

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

async function etag(value: string): Promise<string> {
  return `"${await sha256Hex(value)}"`;
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

/** Paths the server owns outright: an unknown one is a 404, never the SPA shell. */
export function isServerPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/api" || pathname.startsWith("/mcp") || pathname.startsWith("/.well-known/");
}

function staticResponse(root: string, pathname: string): Response | null {
  if (isServerPath(pathname)) return null;
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
  const mcpMaxBodyBytes = positiveInteger(options.mcpMaxBodyBytes, DEFAULT_MCP_MAX_BODY_BYTES, "MCP body limit");
  const mcpBodyTimeoutMs = positiveInteger(options.mcpBodyTimeoutMs, DEFAULT_MCP_BODY_TIMEOUT_MS, "MCP body timeout");
  const mcpBodyGate = new McpBodyGate(positiveInteger(options.mcpMaxInflightBodies, DEFAULT_MCP_MAX_INFLIGHT_BODIES, "MCP body concurrency"));
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

  // Reachability is checked everywhere; writability only where the executor
  // can prove it without leaving a write behind. The probe used to be inlined
  // here as a savepoint around a temp table, which is Node-only — on D1 it
  // threw, and this handler reported a healthy service as unhealthy.
  app.get("/healthz", async (c) => {
    try {
      await options.database.sqlite.prepare("SELECT 1 AS ok").get();
      await options.database.sqlite.writeProbe?.();
      return c.json({ ok: true });
    } catch { return c.json({ ok: false }, 503); }
  });

  app.get("/api/catalog", async (c) => {
    const songs = await service.catalog();
    const updatedAt = songs.reduce((latest, song) => song.updatedAt > latest ? song.updatedAt : latest, "");
    const revision = (await sha256Hex(JSON.stringify(songs))).slice(0, 16);
    const data = publicDataSchema.parse({ songs, serverVersion: revision, updatedAt: updatedAt || "1970-01-01T00:00:00.000Z" });
    const body = JSON.stringify(data);
    const tag = await etag(body);
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
      const response = envelope(c, favoriteListSchema.parse({ ownerSubject: user.subject, songIds: await service.favoriteSongIds(principal) }), now);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    } catch (error) {
      return failure(c, error, now);
    }
  });
  app.post("/api/favorites/:songId", (c) => mutate(c, async (actor) => {
    const parsed = favoriteSetRequestSchema.safeParse({ ...(await c.req.json()), songId: c.req.param("songId") });
    if (!parsed.success) throw parsed.error;
    return favoriteSetResultSchema.parse(await service.setFavorite(actor, parsed.data));
  }, true));

  app.post("/api/performances", (c) => mutate(c, async (actor) => {
    const parsed = performanceCreateRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return await service.createPerformance(actor, parsed.data);
  }, true));
  app.delete("/api/performances/:id", (c) => mutate(c, async (actor) => {
    const parsed = performanceCancelRequestSchema.safeParse({ ...(await c.req.json()), performanceId: c.req.param("id") });
    if (!parsed.success) throw parsed.error;
    return await service.cancelPerformance(actor, { ...parsed.data, expectedVersion: parsed.data.expectedVersion ?? 1 });
  }, true));
  app.post("/api/songs", (c) => mutate(c, async (actor) => {
    const parsed = songCreateRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return await service.createSong(actor, parsed.data);
  }, true));
  app.patch("/api/songs/:id", (c) => mutate(c, async (actor) => {
    const parsed = songUpdateRequestSchema.safeParse({ ...(await c.req.json()), id: c.req.param("id") });
    if (!parsed.success) throw parsed.error;
    return await service.updateSong(actor, parsed.data);
  }, true));
  app.delete("/api/songs/:id/delete", (c) => mutate(c, async (actor) => {
    const parsed = songDeleteRequestSchema.safeParse({ ...(await c.req.json()), songId: c.req.param("id") });
    if (!parsed.success) throw parsed.error;
    return await service.deleteSong(actor, { id: parsed.data.songId, expectedVersion: parsed.data.expectedVersion, clientRequestId: parsed.data.clientRequestId });
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
    return await service.createTjSong(actor, candidate.data, parsed.data.clientRequestId);
  }, true));

  app.all("/mcp", async (c) => {
    const request = c.req.raw;
    if (resolveGatewayIdentity(request) === null) return mcpBearerChallenge();
    if (request.method !== "POST") {
      const checked = await mcpAuth.verifyRequest(request, []);
      if (!checked.ok) return checked.response;
      if (!roleResolver.resolve(checked.principal.actor)) return mcpBearerChallenge(true);
      return mcpHandler.fetch(request, {
        authInfo: authInfoForPrincipal({ ...checked.principal, scopes: checked.token.scopes }, checked.token.accessToken)
      });
    }
    if (rejectDeclaredMcpBody(request, mcpMaxBodyBytes)) return mcpBodyFailure(413, "MCP request body is too large");
    const release = await mcpBodyGate.acquire();
    try {
      let rawBody: ArrayBuffer;
      try {
        rawBody = await readMcpBody(request, mcpMaxBodyBytes, mcpBodyTimeoutMs);
      } catch (error) {
        if (error instanceof McpBodyTooLarge) return mcpBodyFailure(413, "MCP request body is too large");
        if (error instanceof McpBodyTimedOut) return mcpBodyFailure(408, "MCP request body timed out");
        throw error;
      }
      let body: unknown = null;
      try { body = JSON.parse(new TextDecoder().decode(rawBody)) as unknown; } catch { body = null; }
      const handlerRequest = bodyDerivedMcpRequest(replayRequest(request, rawBody), body);
      const requiredScope = mcpRequiredScopeForBody(body);
      const checked = await mcpAuth.verifyRequest(request, requiredScope ? [requiredScope] : []);
      if (!checked.ok) return checked.response;
      if (!roleResolver.resolve(checked.principal.actor)) return mcpBearerChallenge(true);
      return await settledMcpResponse(mcpHandler.fetchAndWaitForTools(handlerRequest, {
        authInfo: authInfoForPrincipal({ ...checked.principal, scopes: checked.token.scopes }, checked.token.accessToken),
        parsedBody: body ?? undefined
      }));
    } finally {
      release();
    }
  });

  // With an assets root this app is the whole server and owns the 404. Without
  // one it is mounted inside a host (the Worker) that serves statics after it,
  // so an unmatched path must fall through to the host's handler rather than
  // end here as a 404 — Hono stops at the first handler that returns.
  if (options.assetsRoot) {
    const assetsRoot = options.assetsRoot;
    app.all("*", (c) => staticResponse(assetsRoot, new URL(c.req.url).pathname) ?? c.notFound());
  }
  return { app, database: options.database, service, mcpAuth };
}

export { safeAssetPath };
