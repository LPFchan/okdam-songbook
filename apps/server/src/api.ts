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
  type CurrentUser,
  type McpScope
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
  createMcpAuthAdapter,
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
  auth?: BrowserAuth;
  tj?: TjAdapter;
  readingGenerator?: ReadingGenerator;
  mcpAuth?: McpAuthAdapter;
  oauthDiagnosticLogger?: (record: McpOAuthDiagnosticRecord) => void;
  now?: () => string;
}

export interface McpOAuthDiagnosticRecord {
  event: "mcp_oauth";
  at: string;
  endpoint: "authorize" | "token" | "register" | "browser_callback";
  status: number;
  durationMs: number;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface ServerApp {
  app: Hono;
  database: SongbookDatabase;
  service: SongbookService;
  auth?: BrowserAuth;
  mcpAuth: McpAuthAdapter;
}

const JSON_MEDIA_TYPE = /^application\/json(?:\s*;|$)/i;
const PUBLIC_MCP_SCOPES: McpScope[] = ["songbook:read", "songbook:write"];
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

function oauthFingerprint(value: string | null | undefined): string | null {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : null;
}

function oauthValue(value: unknown): string | null {
  return typeof value === "string" && value.length <= 200 ? value : null;
}

function oauthLabel(value: unknown): string | null {
  const parsed = oauthValue(value);
  return parsed && /^[a-z][a-z0-9_:-]{0,63}$/u.test(parsed) ? parsed : null;
}

function oauthScopeFacts(value: unknown): Record<string, unknown> {
  const allowed = new Set(["openid", "profile", "email", "offline_access", "songbook:read", "songbook:write"]);
  const legacy = new Set(["songbook:admin"]);
  const requested = String(value ?? "").split(/\s+/u).filter(Boolean);
  const unknown = requested.filter((scope) => !allowed.has(scope) && !legacy.has(scope));
  return {
    known: requested.filter((scope) => allowed.has(scope)).sort(),
    legacy: requested.filter((scope) => legacy.has(scope)).sort(),
    unknown: unknown.map((scope) => oauthLabel(scope) ?? `sha256:${oauthFingerprint(scope)}`),
    unknownCount: unknown.length
  };
}

function normalizeLegacyMcpAuthorizeRequest(request: Request): Request {
  const url = new URL(request.url);
  const requested = (url.searchParams.get("scope") ?? "").split(/\s+/u).filter(Boolean);
  if (!requested.includes("songbook:admin")) return request;
  const normalized = Array.from(new Set(requested.map((scope) => scope === "songbook:admin" ? "songbook:write" : scope)));
  url.searchParams.set("scope", normalized.join(" "));
  return new Request(url, request);
}

function oauthRedirectFacts(location: string | null, origin: string): Record<string, unknown> {
  if (!location) return { kind: "none" };
  try {
    const url = new URL(location, origin);
    const sameOrigin = url.origin === origin;
    const kind = sameOrigin
      ? url.pathname === "/" ? "login" : "same_origin"
      : url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com" ? "chatgpt_callback" : "external";
    return {
      kind,
      hasCode: url.searchParams.has("code"),
      code: oauthFingerprint(url.searchParams.get("code")),
      hasState: url.searchParams.has("state"),
      hasIssuer: url.searchParams.has("iss"),
      error: oauthLabel(url.searchParams.get("error"))
    };
  } catch {
    return { kind: "invalid" };
  }
}

function oauthCookieNames(headers: Headers): string[] {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter((value): value is string => Boolean(value));
  return values.map((value) => value.slice(0, value.indexOf("="))).filter(Boolean).sort();
}

async function oauthRequestFacts(request: Request, endpoint: McpOAuthDiagnosticRecord["endpoint"], origin: string): Promise<Record<string, unknown>> {
  if (endpoint === "browser_callback") {
    return { hasPendingMcpLogin: /(?:^|;\s*)oidc_login_prompt=/u.test(request.headers.get("Cookie") ?? "") };
  }
  if (endpoint === "authorize") {
    const url = new URL(request.url);
    return {
      client: oauthFingerprint(url.searchParams.get("client_id")),
      redirect: oauthRedirectFacts(url.searchParams.get("redirect_uri"), origin),
      scopes: oauthScopeFacts(url.searchParams.get("scope")),
      hasPkce: url.searchParams.get("code_challenge_method")?.toUpperCase() === "S256" && url.searchParams.has("code_challenge"),
      resourceMatches: url.searchParams.get("resource") === `${origin}/mcp`,
      prompt: oauthLabel(url.searchParams.get("prompt"))
    };
  }
  let body: Record<string, unknown> = {};
  try {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) body = await request.clone().json() as Record<string, unknown>;
    else body = Object.fromEntries(new URLSearchParams(await request.clone().text()));
  } catch {
    body = {};
  }
  if (endpoint === "register") {
    const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    return {
      redirectKinds: redirects.map((value) => oauthRedirectFacts(typeof value === "string" ? value : null, origin).kind),
      tokenAuthMethod: oauthLabel(body.token_endpoint_auth_method)
    };
  }
  return {
    grantType: oauthLabel(body.grant_type),
    client: oauthFingerprint(oauthValue(body.client_id)),
    code: oauthFingerprint(oauthValue(body.code)),
    hasCodeVerifier: Boolean(oauthValue(body.code_verifier)),
    resourceMatches: oauthValue(body.resource) === `${origin}/mcp`
  };
}

async function oauthResponseFacts(response: Response, endpoint: McpOAuthDiagnosticRecord["endpoint"], origin: string): Promise<Record<string, unknown>> {
  if (endpoint === "authorize" || endpoint === "browser_callback") {
    return {
      redirect: oauthRedirectFacts(response.headers.get("Location"), origin),
      setCookies: oauthCookieNames(response.headers)
    };
  }
  let payload: Record<string, unknown> = {};
  try { payload = await response.clone().json() as Record<string, unknown>; } catch { /* no JSON body */ }
  if (endpoint === "register") {
    return {
      outcome: response.ok ? "registered" : "oauth_error",
      client: response.ok ? oauthFingerprint(oauthValue(payload.client_id)) : null,
      error: response.ok ? null : oauthLabel(payload.error)
    };
  }
  return {
    outcome: response.ok && typeof payload.access_token === "string" ? "issued" : response.ok ? "unexpected_success" : "oauth_error",
    scopes: response.ok ? oauthScopeFacts(payload.scope) : oauthScopeFacts(""),
    error: response.ok ? null : oauthLabel(payload.error)
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
  const mcpHandler = createSongbookMcpHandler({ service, tj: options.tj });
  const oauthDiagnosticLogger = options.oauthDiagnosticLogger ?? ((record: McpOAuthDiagnosticRecord) => console.info(JSON.stringify(record)));
  const app = new Hono();

  const logOAuthExchange = async (endpoint: McpOAuthDiagnosticRecord["endpoint"], request: Request, response: Response, startedAt: number) => {
    try {
      oauthDiagnosticLogger({
        event: "mcp_oauth",
        at: now(),
        endpoint,
        status: response.status,
        durationMs: Date.now() - startedAt,
        request: await oauthRequestFacts(request, endpoint, options.origin),
        response: await oauthResponseFacts(response, endpoint, options.origin)
      });
    } catch {
      // Diagnostics must never alter an OAuth response.
    }
  };

  const protectBrowser = async (c: Context): Promise<BrowserPrincipal | Response> => {
    if (hasAuthorizationHeader(c)) return failure(c, new DomainError("UNAUTHORIZED", "브라우저 세션이 필요해."), now);
    const principal = await sessionResolver(c.req.raw);
    const user = principal && currentUser(principal, roleResolver);
    if (!principal || !user) return failure(c, new DomainError("UNAUTHORIZED", "로그인 또는 허용된 계정이 필요해."), now);
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
      const response = envelope(c, favoriteListSchema.parse({ songIds: service.favoriteSongIds(principal) }), now);
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
  }));

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
  app.delete("/api/songs/:id/delete", (c) => mutate(c, async (actor) => {
    const parsed = songDeleteRequestSchema.safeParse({ ...(await c.req.json()), songId: c.req.param("id") });
    if (!parsed.success) throw parsed.error;
    return service.deleteSong(actor, { id: parsed.data.songId, expectedVersion: parsed.data.expectedVersion, clientRequestId: parsed.data.clientRequestId });
  }));

  app.post("/api/readings/generate", (c) => mutate(c, async () => {
    if (!options.readingGenerator) throw new DomainError("AI_NOT_CONFIGURED", "독음 자동 생성이 설정되지 않았어. 수동으로 입력해줘.");
    const parsed = readingGenerateInputSchema.safeParse(await c.req.json());
    if (!parsed.success) throw parsed.error;
    return options.readingGenerator.generate(parsed.data);
  }));

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
  }));

  app.get("/.well-known/oauth-authorization-server", (c) => c.json(publicMcpMetadata(options.origin)));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata(options.origin)));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata(options.origin)));

  const authAlias = async (c: Context, target: string): Promise<Response> => {
    if (!auth) return c.notFound();
    const startedAt = Date.now();
    const url = new URL(c.req.url);
    url.pathname = `/api/auth${target}`;
    const request = new Request(url, c.req.raw);
    const diagnosticRequest = request.clone();
    const providerRequest = target === "/mcp/authorize" ? normalizeLegacyMcpAuthorizeRequest(request) : request;
    const response = await auth.handler(providerRequest);
    if (target === "/mcp/token" && response.ok) await mcpAuth.captureToken(response.clone(), c.req.raw);
    const endpoint = target.slice(5) as "authorize" | "token" | "register";
    await logOAuthExchange(endpoint, diagnosticRequest, response.clone(), startedAt);
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
    const request = c.req.raw;
    const startedAt = Date.now();
    const response = await auth.handler(request);
    if (new URL(request.url).pathname.startsWith("/api/auth/callback/")) {
      await logOAuthExchange("browser_callback", request.clone(), response.clone(), startedAt);
    }
    return response;
  };
  app.on(["GET", "POST", "OPTIONS"], "/api/auth/*", authHandler);
  app.all("/mcp", async (c) => {
    const request = c.req.raw;
    const body = request.method === "POST" ? await request.clone().json().catch(() => null) : null;
    const handlerRequest = bodyDerivedMcpRequest(request, body);
    if (request.headers.get("Authorization") === null) {
      if (!anonymousMcpRequestAllowed(request.method, body)) return mcpBearerChallenge(options.origin);
      return mcpHandler.fetch(handlerRequest, { parsedBody: body ?? undefined });
    }
    const requiredScope = mcpRequiredScopeForBody(body);
    const checked = await mcpAuth.verifyRequest(request, requiredScope ? [requiredScope] : []);
    if (!checked.ok) return checked.response;
    if (!roleResolver.resolve(checked.principal.actor)) return mcpBearerChallenge(options.origin, true);
    return mcpHandler.fetch(handlerRequest, {
      authInfo: authInfoForPrincipal({ ...checked.principal, scopes: checked.token.scopes }, checked.token.accessToken),
      parsedBody: body ?? undefined
    });
  });

  app.all("*", (c) => {
    const staticFile = staticResponse(options.assetsRoot, new URL(c.req.url).pathname);
    return staticFile ?? c.notFound();
  });
  return { app, database: options.database, service, auth, mcpAuth };
}

export { publicMcpMetadata, protectedResourceMetadata, safeAssetPath };
