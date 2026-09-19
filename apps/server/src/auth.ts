import { identityFrom } from "@lost-plus/gateway-identity";
import type { RequestActor, ResolvedActor, RoleResolver } from "@songbook/server-core";
import { normalizeEmail, type McpScope } from "@songbook/shared";

export interface GatewayIdentity {
  sub: string;
  email: string;
  name: string;
  role: "administrator" | "user";
}

const roles = ["administrator", "user"] as const satisfies readonly GatewayIdentity["role"][];

/**
 * The identity the Common Auth gateway attached, or null. Decoding and the
 * hub's limits (80-character names, the two known roles) come from the shared
 * parser; the hub already trims and validates the email, so only the
 * lower-casing this codebase keys on is applied here.
 */
export function resolveGatewayIdentity(request: Request): GatewayIdentity | null {
  const identity = identityFrom(request.headers, { maxNameLength: 80, roles });
  if (!identity) return null;
  const role = roles.find((candidate) => candidate === identity.role);
  if (!role) return null;
  return { sub: identity.sub, email: normalizeEmail(identity.email), name: identity.name, role };
}

/** Every identity reaching this resolver has already been admitted by Common Auth. */
export function createCommonAuthRoleResolver(): RoleResolver {
  return {
    resolve: (actor: RequestActor): ResolvedActor | null => {
      const email = normalizeEmail(actor.email);
      if (!email) return null;
      const displayName = actor.displayName?.trim() || email;
      const subject = actor.subject?.trim() || `legacy-email:${email}`;
      return { subject, email, displayName, role: "allowed" };
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
          actor: { subject: `auth.lost.plus:${identity.sub}`, email: identity.email, displayName: identity.name }
        }
      };
    }
  };
}
