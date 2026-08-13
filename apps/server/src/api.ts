import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  currentUserSchema,
  performanceCancelRequestSchema,
  performanceCreateRequestSchema,
  publicDataSchema,
  songCreateRequestSchema,
  songRestoreRequestSchema,
  songUpdateRequestSchema,
  tjAddResultSchema,
  tjLookupRequestSchema,
  tjSearchRequestSchema,
  type CurrentUser,
  type McpScope,
  type UserRole
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
  createBrowserAuth,
  createAllowlistRoleResolver,
  type BrowserAuth,
  type BrowserAuthConfig,
  initializeBrowserAuth,
  type McpAuthAdapter,
  createMcpAuthAdapter
} from "./auth.js";
import { authInfoForPrincipal, createSongbookMcpHandler } from "@songbook/mcp";

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
  auth?: BrowserAuth;
  tj?: TjAdapter;
  mcpAuth?: McpAuthAdapter;
  now?: () => string;
}

export interface ServerApp {
  app: Hono;
  database: SongbookDatabase;
  service: SongbookService;
  auth?: BrowserAuth;
  mcpAuth: McpAuthAdapter;
}

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/i;
const PUBLIC_MCP_SCOPES: McpScope[] = ["songbook:read", "songbook:write", "songbook:admin"];

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
    TJ_RATE_LIMITED: 429, RATE_LIMITED: 429
  };
  return c.json({ ok: false, data: null, error: mapped, requestId: requestId(c), serverTime: now() }, (status ?? codeStatus[mapped.code] ?? 500) as 500);
}

function validationFailure(c: Context, error: unknown, now: () => string): Response {
  const details = error && typeof error === "object" && "flatten" in error && typeof error.flatten === "function" ? error.flatten() : null;
  return failure(c, new DomainError("VALIDATION_ERROR", "입력 형식이 올바르지 않아.", details), now, 400);
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

function hasBearer(c: Context): boolean {
  return Boolean(c.req.header("Authorization"));
}

function etag(value: string): string {
  return `"${createHash("sha256").update(value).digest("hex")}"`;
}

function publicMcpMetadata(origin: string): Record<string, unknown> {
  const issuer = `${origin}/api/auth`;
  return {
    issuer,
    authorization_endpoint: `${issuer}/mcp/authorize`,
    token_endpoint: `${issuer}/mcp/token`,
    registration_endpoint: `${issuer}/mcp/register`,
    jwks_uri: `${origin}/api/auth/mcp/jwks`,
    scopes_supported: ["openid", "profile", "email", "offline_access", ...PUBLIC_MCP_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: ["sub", "iss", "aud", "exp", "nbf", "iat", "jti", "email", "email_verified", "name"]
  };
}

function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [`${origin}/api/auth`],
    jwks_uri: `${origin}/api/auth/mcp/jwks`,
    scopes_supported: PUBLIC_MCP_SCOPES,
    bearer_methods_supported: ["header"],
    resource_signing_alg_values_supported: ["RS256"]
  };
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

function staticResponse(root: string | undefined, pathname: string): Response | null {
  if (!root) return null;
  if (pathname.startsWith("/api/") || pathname === "/api" || pathname.startsWith("/mcp") || pathname.startsWith("/.well-known/")) return null;
  const direct = safeAssetPath(root, pathname);
  if (direct && existsSync(direct) && statSync(direct).isFile()) return new Response(readFileSync(direct), { headers: { "Content-Type": contentType(direct) } });
  const fallback = safeAssetPath(root, "/index.html");
  if (fallback && existsSync(fallback) && statSync(fallback).isFile()) return new Response(readFileSync(fallback), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  return null;
}

async function authSession(auth: BrowserAuth, request: Request): Promise<BrowserPrincipal | null> {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session) return null;
  return { id: session.user.id, email: session.user.email, displayName: session.user.name, expiresAt: session.session.expiresAt };
}

function currentUser(principal: BrowserPrincipal, roleResolver: RoleResolver): CurrentUser | null {
  const resolved = roleResolver.resolve(principal);
  if (!resolved) return null;
  return currentUserSchema.parse({ email: resolved.email, displayName: resolved.displayName, role: resolved.role });
}

export async function createConfiguredServer(options: Omit<ServerAppOptions, "auth" | "roleResolver"> & { auth: BrowserAuthConfig }): Promise<ServerApp> {
  const auth = createBrowserAuth(options.auth);
  await initializeBrowserAuth(auth);
  return createServerApp({ ...options, auth, roleResolver: createAllowlistRoleResolver(options.auth.allowedUsers) });
}

export function createServerApp(options: ServerAppOptions): ServerApp {
  const now = options.now ?? (() => new Date().toISOString());
  const roleResolver = options.roleResolver ?? { resolve: () => null };
  const service = options.service ?? createSongbookService(options.database, { roleResolver, now });
  const auth = options.auth;
  const sessionResolver = options.sessionResolver ?? (auth ? (request: Request) => authSession(auth, request) : async () => null);
  const mcpAuth = options.mcpAuth ?? (auth ? createMcpAuthAdapter({ auth, database: options.database, origin: options.origin }) : createMcpAuthAdapter({ database: options.database, origin: options.origin }));
  const mcpHandler = createSongbookMcpHandler({ service });
  const app = new Hono();

  const protectBrowser = async (c: Context, action?: UserRole): Promise<BrowserPrincipal | Response> => {
    if (hasBearer(c)) return failure(c, new DomainError("UNAUTHORIZED", "브라우저 세션이 필요해."), now);
    const principal = await sessionResolver(c.req.raw);
    const user = principal && currentUser(principal, roleResolver);
    if (!principal || !user) return failure(c, new DomainError("UNAUTHORIZED", "로그인 또는 허용된 계정이 필요해."), now);
    if (action === "owner" && user.role !== "owner") return failure(c, new DomainError("FORBIDDEN", "소유자 권한이 필요해."), now);
    return principal;
  };

  const mutate = async (c: Context, fn: (actor: BrowserPrincipal) => Promise<unknown> | unknown): Promise<Response> => {
    const bodyError = jsonBodyRequired(c);
    if (bodyError) return bodyError;
    if (!sameOrigin(c, options.origin)) return failure(c, new DomainError("FORBIDDEN", "같은 출처 요청만 허용해."), now);
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
    if (hasBearer(c)) return failure(c, new DomainError("UNAUTHORIZED", "브라우저 세션이 필요해."), now);
    const principal = await sessionResolver(c.req.raw);
    if (!principal) return failure(c, new DomainError("UNAUTHORIZED", "로그인 세션이 없어."), now);
    const user = currentUser(principal, roleResolver);
    if (!user) return failure(c, new DomainError("UNAUTHORIZED", "허용된 계정이 필요해."), now);
    return envelope(c, { user: { id: principal.id ?? principal.email, email: user.email, name: user.displayName, role: user.role }, session: { id: principal.id ?? principal.email, expiresAt: principal.expiresAt ?? now() } }, now);
  });

  app.post("/api/performances", (c) => mutate(c, async (actor) => {
    const parsed = performanceCreateRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return service.createPerformance(actor, parsed.data);
  }));
  app.delete("/api/performances/:id", (c) => mutate(c, async (actor) => {
    const parsed = performanceCancelRequestSchema.safeParse({ ...(await c.req.json()), performanceId: c.req.param("id") });
    if (!parsed.success) throw parsed.error;
    return service.cancelPerformance(actor, { ...parsed.data, expectedVersion: parsed.data.expectedVersion ?? 1 });
  }));
  app.post("/api/songs", (c) => mutate(c, async (actor) => {
    const parsed = songCreateRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return service.createSong(actor, parsed.data);
  }));
  app.patch("/api/songs/:id", (c) => mutate(c, async (actor) => {
    const parsed = songUpdateRequestSchema.safeParse({ ...(await c.req.json()), id: c.req.param("id") });
    if (!parsed.success) throw parsed.error;
    return service.updateSong(actor, parsed.data);
  }));
  app.post("/api/songs/:id/restore", async (c) => {
    const bodyError = jsonBodyRequired(c);
    if (bodyError) return bodyError;
    if (!sameOrigin(c, options.origin)) return failure(c, new DomainError("FORBIDDEN", "같은 출처 요청만 허용해."), now);
    const principal = await protectBrowser(c, "owner");
    if (principal instanceof Response) return principal;
    try {
      const parsed = songRestoreRequestSchema.safeParse({ ...(await c.req.json()), songId: c.req.param("id") });
      if (!parsed.success) return validationFailure(c, parsed.error, now);
      return envelope(c, service.restoreSong(principal, { id: parsed.data.songId, expectedVersion: parsed.data.expectedVersion, clientRequestId: parsed.data.clientRequestId }), now);
    } catch (error) { return failure(c, error, now); }
  });

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
    const candidate = tjAddResultSchema.shape.song; // keeps this route's validation independent from provider HTML
    void candidate;
    const cnd = z.object({ tjNumber: z.string().regex(/^\d+$/), title: z.string().min(1), artist: z.string().min(1), lyricist: z.string().default(""), composer: z.string().default(""), sourceUrl: z.string().url() }).parse(parsed.data.candidate);
    const duplicate = service.checkDuplicate({ tjNumber: cnd.tjNumber, title: cnd.title, artist: cnd.artist });
    if (duplicate) return { outcome: duplicate.deletedAt ? "deleted" : "duplicate", song: null, existing: duplicate, duplicateKind: duplicate.tjNumber === cnd.tjNumber ? "tjNumber" : "titleArtist", canRestore: false, canOpen: true };
    const song = service.createSong(actor, {
      tjNumber: cnd.tjNumber, title: cnd.title, artist: cnd.artist, titleReadingKo: "", titleRomanized: "", titleAliases: [], artistReadingKo: "", artistAliases: [], country: "", genres: [], originalWork: "", keyCandidates: [], performerIds: [], memo: "", status: "active", youtubeUrl: "", youtubeVideoId: "", isOfficialTjVideo: null, sourceType: "tjmedia", sourceReference: cnd.sourceUrl, createdByName: actor.displayName ?? "", updatedByName: actor.displayName ?? "", clientRequestId: parsed.data.clientRequestId
    });
    return { outcome: "created", song, existing: null, duplicateKind: null, canRestore: false, canOpen: true };
  }));

  app.get("/.well-known/oauth-authorization-server", (c) => c.json(publicMcpMetadata(options.origin)));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(options.origin)));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(options.origin)));

  const authAlias = async (c: Context, target: string): Promise<Response> => {
    if (!auth) return c.notFound();
    const url = new URL(c.req.url);
    url.pathname = `/api/auth${target}`;
    const request = new Request(url, c.req.raw);
    const response = await auth.handler(request);
    if (target === "/mcp/token" && response.ok) await mcpAuth.captureToken(response.clone(), c.req.raw);
    return response;
  };
  // Keep the provider's direct token and discovery paths behind the same
  // application-owned aliases; the generic auth wildcard must come last.
  app.get("/api/auth/.well-known/oauth-authorization-server", (c) => c.json(publicMcpMetadata(options.origin)));
  app.get("/api/auth/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(options.origin)));
  app.get("/api/auth/mcp/authorize", (c) => authAlias(c, "/mcp/authorize"));
  app.post("/api/auth/mcp/token", (c) => authAlias(c, "/mcp/token"));
  app.post("/api/auth/mcp/register", (c) => authAlias(c, "/mcp/register"));
  app.get("/mcp/authorize", (c) => authAlias(c, "/mcp/authorize"));
  app.post("/mcp/token", (c) => authAlias(c, "/mcp/token"));
  app.post("/mcp/register", (c) => authAlias(c, "/mcp/register"));
  const authHandler = async (c: Context): Promise<Response> => {
    if (!auth) return c.notFound();
    return auth.handler(c.req.raw);
  };
  app.on(["GET", "POST", "OPTIONS"], "/api/auth/*", authHandler);
  app.all("/mcp", async (c) => {
    const body = c.req.method === "POST" ? await c.req.raw.clone().json().catch(() => null) as { method?: unknown; params?: { name?: unknown } } | null : null;
    const toolName = body?.method === "tools/call" && typeof body.params?.name === "string" ? body.params.name : "";
    const requiredScope = toolName === "record_performance" || toolName === "cancel_performance" ? "songbook:write" : "songbook:read";
    const checked = await mcpAuth.verifyRequest(c.req.raw, [requiredScope]);
    if (!checked.ok) return checked.response;
    if (!roleResolver.resolve(checked.principal.actor)) return failure(c, new DomainError("UNAUTHORIZED", "로그인 또는 허용된 계정이 필요해."), now);
    return mcpHandler.fetch(c.req.raw, { authInfo: authInfoForPrincipal({ ...checked.principal, scopes: checked.token.scopes }, checked.token.accessToken) });
  });

  app.all("*", (c) => {
    const staticFile = staticResponse(options.assetsRoot, new URL(c.req.url).pathname);
    return staticFile ?? c.notFound();
  });
  return { app, database: options.database, service, auth, mcpAuth };
}

export { publicMcpMetadata, protectedResourceMetadata, safeAssetPath };
