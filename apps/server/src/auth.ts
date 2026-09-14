import type { RequestActor, ResolvedActor, RoleResolver } from "@songbook/server-core";
import { normalizeEmail, type McpScope } from "@songbook/shared";
import { z } from "zod";

const gatewayIdentitySchema = z.object({
  sub: z.string().trim().min(1),
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["administrator", "user"])
});

export interface GatewayIdentity {
  sub: string;
  email: string;
  name: string;
  role: "administrator" | "user";
}

function decodedHeader(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function resolveGatewayIdentity(request: Request): GatewayIdentity | null {
  if (request.headers.get("X-Lost-Plus-Encoding") !== "percent-utf8") return null;
  const parsed = gatewayIdentitySchema.safeParse({
    sub: decodedHeader(request, "X-Lost-Plus-Sub"),
    email: decodedHeader(request, "X-Lost-Plus-Email"),
    name: decodedHeader(request, "X-Lost-Plus-Name"),
    role: decodedHeader(request, "X-Lost-Plus-Role")
  });
  if (!parsed.success) return null;
  return { ...parsed.data, email: normalizeEmail(parsed.data.email) };
}

/** Every identity reaching this resolver has already been admitted by Common Auth. */
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

export function createGatewayMcpAuthAdapter(): McpAuthAdapter {
  const scopes: McpScope[] = ["songbook:read", "songbook:write"];
  return {
    async verifyRequest(request, requiredScopes) {
      const identity = resolveGatewayIdentity(request);
      if (!identity) return { ok: false, response: unauthorized("Invalid gateway identity", true) };
      if (requiredScopes.some((scope) => !scopes.includes(scope))) {
        return { ok: false, response: new Response(JSON.stringify({ ok: false, error: "The credential does not grant the requested permission" }), { status: 403, headers: { "Content-Type": "application/json" } }) };
      }
      return {
        ok: true,
        token: { accessToken: "gateway-verified", scopes },
        principal: {
          userId: identity.sub,
          actor: { email: identity.email, displayName: identity.name }
        }
      };
    }
  };
}
