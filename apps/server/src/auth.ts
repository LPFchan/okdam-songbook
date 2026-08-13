import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { mcp } from "better-auth/plugins";
import type Database from "better-sqlite3";
import type { RequestActor, ResolvedActor, RoleResolver, SongbookDatabase } from "@songbook/server-core";
import { normalizeEmail, parseAuthorizationHeader, type McpScope } from "@songbook/shared";

export interface BrowserAuthConfig {
  database: SongbookDatabase;
  origin: string;
  secret: string;
  googleClientId?: string;
  googleClientSecret?: string;
  allowedUsers?: Record<string, "owner" | "editor"> | string[];
  production?: boolean;
}

export type BrowserAuth = Auth<BetterAuthOptions>;

export function allowedUserMap(value: BrowserAuthConfig["allowedUsers"]): Map<string, "owner" | "editor"> {
  if (Array.isArray(value)) {
    const entries: Array<[string, "editor"]> = [];
    for (const email of value) { const normalized = normalizeEmail(email); if (normalized) entries.push([normalized, "editor"]); }
    return new Map(entries);
  }
  const entries: Array<[string, "owner" | "editor"]> = [];
  for (const [email, role] of Object.entries(value ?? {})) { const normalized = normalizeEmail(email); if (normalized) entries.push([normalized, role]); }
  return new Map(entries);
}

/** Resolve admission and role from the configured allowlist on every call. */
export function createAllowlistRoleResolver(value: BrowserAuthConfig["allowedUsers"]): RoleResolver {
  const allowed = allowedUserMap(value);
  return {
    resolve: (actor: RequestActor): ResolvedActor | null => {
      const role = allowed.get(normalizeEmail(actor.email));
      return role ? { email: normalizeEmail(actor.email), displayName: actor.displayName ?? actor.email, role } : null;
    }
  };
}

/**
 * Better Auth owns browser sessions and its OAuth provider. The allowlist
 * admission hook only prevents unknown accounts from being created; request
 * authorization still resolves the current allowlist/role through server-core.
 */
export function createBrowserAuth(config: BrowserAuthConfig): BrowserAuth {
  if (!config.secret || config.secret.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  const allowed = allowedUserMap(config.allowedUsers);
  const plugins = [mcp({
    loginPage: "/",
    resource: `${config.origin}/mcp`,
    oidcConfig: { loginPage: "/", scopes: ["songbook:read", "songbook:write", "songbook:admin"] }
  })];
  return betterAuth({
    database: config.database.sqlite as unknown as Database.Database,
    secret: config.secret,
    baseURL: config.origin,
    basePath: "/api/auth",
    defaultCookieAttributes: {
      sameSite: "lax",
      secure: config.production ?? true,
      httpOnly: true
    },
    trustedOrigins: [config.origin],
    socialProviders: config.googleClientId && config.googleClientSecret ? {
      google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret, disableSignUp: false }
    } : undefined,
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => allowed.has(normalizeEmail(user.email))
        }
      }
    },
    plugins
  }) as unknown as BrowserAuth;
}

export async function initializeBrowserAuth(auth: BrowserAuth): Promise<void> {
  const context = await auth.$context;
  await context.runMigrations();
}

export interface McpTokenBinding {
  accessToken: string;
  resource: string;
  scopes: McpScope[];
  expiresAt: string;
}

export interface McpAuthAdapter {
  captureToken(response: Response, request: Request): Promise<void>;
  verifyRequest(request: Request, requiredScopes: McpScope[]): Promise<{ ok: true; token: McpTokenBinding; session: unknown } | { ok: false; response: Response }>;
}

function unauthorized(message: string, resource: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource/mcp"`
    }
  });
}

function forbidden(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 403,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer error=\"insufficient_scope\"" }
  });
}

/**
 * Narrow resource-server adapter. The Better Auth MCP plugin returns opaque
 * tokens without RFC8707 audience data, so the application-owned binding is
 * inserted immediately after token issuance and checked before getMcpSession.
 */
export function createMcpAuthAdapter(options: { auth?: BrowserAuth; database: SongbookDatabase; origin: string }): McpAuthAdapter {
  const canonical = `${options.origin}/mcp`;
  const sqlite = options.database.sqlite;
  return {
    async captureToken(response, request) {
      if (!response.ok) return;
      const payload = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown; scope?: unknown } | null;
      if (!payload || typeof payload.access_token !== "string") return;
      const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3600;
      const scopes = String(payload.scope ?? "").split(/\s+/).filter((scope): scope is McpScope => scope === "songbook:read" || scope === "songbook:write" || scope === "songbook:admin");
      sqlite.prepare(`INSERT INTO mcp_token_resources (access_token,resource,scopes,expires_at,created_at) VALUES (?,?,?,?,?) ON CONFLICT(access_token) DO UPDATE SET resource=excluded.resource,scopes=excluded.scopes,expires_at=excluded.expires_at`).run(payload.access_token, canonical, scopes.join(" "), new Date(Date.now() + expiresIn * 1000).toISOString(), new Date().toISOString());
      void request;
    },
    async verifyRequest(request, requiredScopes) {
      if (request.headers.get("Cookie")) return { ok: false, response: unauthorized("Bearer authentication is required", canonical) };
      const token = parseAuthorizationHeader(request.headers.get("Authorization"));
      if (!token) return { ok: false, response: unauthorized("Bearer authentication is required", canonical) };
      const row = sqlite.prepare("SELECT access_token,resource,scopes,expires_at FROM mcp_token_resources WHERE access_token=?").get(token) as { access_token: string; resource: string; scopes: string; expires_at: string } | undefined;
      if (!row || row.resource !== canonical || Date.parse(row.expires_at) <= Date.now()) return { ok: false, response: unauthorized("Invalid or resource-mismatched token", canonical) };
      const scopes = row.scopes.split(/\s+/).filter((scope): scope is McpScope => scope === "songbook:read" || scope === "songbook:write" || scope === "songbook:admin");
      if (requiredScopes.some((scope) => !scopes.includes(scope))) return { ok: false, response: forbidden("The token does not grant the requested scope") };
      if (!options.auth) return { ok: false, response: unauthorized("OAuth provider is not configured", canonical) };
      const authHeaders = new Headers(request.headers);
      authHeaders.set("Authorization", `Bearer ${token}`);
      const getMcpSession = (options.auth.api as unknown as { getMcpSession: (input: { headers: Headers; asResponse: false }) => Promise<unknown> }).getMcpSession;
      const session = await getMcpSession({ headers: authHeaders, asResponse: false });
      if (!session) return { ok: false, response: unauthorized("Invalid or expired token", canonical) };
      return { ok: true, token: { accessToken: row.access_token, resource: row.resource, scopes, expiresAt: row.expires_at }, session };
    }
  };
}

export function mcpScopeFromString(value: string): McpScope[] {
  return value.split(/\s+/).filter((scope): scope is McpScope => scope === "songbook:read" || scope === "songbook:write" || scope === "songbook:admin");
}
