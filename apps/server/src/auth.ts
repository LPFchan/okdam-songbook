import type { RequestActor, ResolvedActor, RoleResolver } from "@songbook/server-core";
import { normalizeEmail, type McpScope } from "@songbook/shared";
import { z } from "zod";

const commonAuthIdentitySchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["administrator", "user"]),
  services: z.array(z.string())
});

export interface CommonAuthIdentity {
  email: string;
  name: string;
  role: "administrator" | "user";
  services: string[];
}

export interface CommonAuthConfig {
  origin: string;
  serviceKey: string;
  fetch?: typeof globalThis.fetch;
}

export interface CommonAuthClient {
  origin: string;
  resolve(request: Request): Promise<CommonAuthIdentity | null>;
  logout(request: Request): Promise<Response>;
}

function forwardedCredentials(request: Request): Headers {
  const headers = new Headers();
  const cookie = request.headers.get("Cookie");
  const authorization = request.headers.get("Authorization");
  if (cookie !== null) headers.set("Cookie", cookie);
  if (authorization !== null) headers.set("Authorization", authorization);
  return headers;
}

export function createCommonAuthClient(config: CommonAuthConfig): CommonAuthClient {
  const origin = config.origin.trim().replace(/\/$/u, "");
  const serviceKey = config.serviceKey.trim();
  if (!origin) throw new Error("AUTH_ORIGIN is required");
  if (!serviceKey) throw new Error("common auth serviceKey is required");
  const request = config.fetch ?? globalThis.fetch;

  return {
    origin,
    async resolve(incoming) {
      let response: Response;
      try {
        response = await request(`${origin}/api/whoami`, {
          method: "GET",
          headers: forwardedCredentials(incoming)
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
      const parsed = commonAuthIdentitySchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return null;
      if (parsed.data.services.length > 0 && !parsed.data.services.includes(serviceKey)) return null;
      return { ...parsed.data, email: normalizeEmail(parsed.data.email) };
    },
    logout(incoming) {
      return request(`${origin}/api/logout`, {
        method: "POST",
        headers: forwardedCredentials(incoming)
      });
    }
  };
}

/** Every identity reaching this resolver has already been admitted by common auth. */
export function createCommonAuthRoleResolver(): RoleResolver {
  return {
    resolve: (actor: RequestActor): ResolvedActor | null => {
      const email = normalizeEmail(actor.email);
      if (!email) return null;
      const displayName = actor.displayName?.trim() || email;
      return { email, displayName, role: "allowed" };
    }
  };
}

export interface McpTokenBinding {
  accessToken: string;
  scopes: McpScope[];
}

export interface McpPrincipal {
  userId: string;
  actor: RequestActor;
}

export interface McpAuthAdapter {
  verifyRequest(request: Request, requiredScopes: McpScope[]): Promise<{ ok: true; token: McpTokenBinding; principal: McpPrincipal } | { ok: false; response: Response }>;
}

function unauthorized(message: string, invalidToken = false): Response {
  const challenge = invalidToken
    ? 'Bearer realm="auth.lost.plus", error="invalid_token"'
    : 'Bearer realm="auth.lost.plus"';
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": challenge
    }
  });
}

export function mcpBearerChallenge(invalidToken = false): Response {
  return unauthorized(invalidToken ? "Invalid bearer authentication" : "Bearer authentication is required", invalidToken);
}

export function createMcpAuthAdapter(auth: CommonAuthClient): McpAuthAdapter {
  const scopes: McpScope[] = ["songbook:read", "songbook:write"];
  return {
    async verifyRequest(request, requiredScopes) {
      const authorization = request.headers.get("Authorization");
      if (authorization === null) return { ok: false, response: unauthorized("Bearer authentication is required") };
      const identity = await auth.resolve(request);
      if (!identity) return { ok: false, response: unauthorized("Invalid bearer authentication", true) };
      if (requiredScopes.some((scope) => !scopes.includes(scope))) {
        return { ok: false, response: new Response(JSON.stringify({ ok: false, error: "The credential does not grant the requested permission" }), { status: 403, headers: { "Content-Type": "application/json" } }) };
      }
      const accessToken = authorization.replace(/^Bearer\s+/iu, "");
      return {
        ok: true,
        token: { accessToken, scopes },
        principal: {
          userId: identity.email,
          actor: { email: identity.email, displayName: identity.name }
        }
      };
    }
  };
}
