import { describe, expect, it } from "vitest";
import { createCommonAuthRoleResolver, createGatewayMcpAuthAdapter, performerAccountsFromEnvironment, resolveGatewayIdentity } from "../src/auth.js";

function gatewayHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    "X-Lost-Plus-Encoding": "percent-utf8",
    "X-Lost-Plus-Sub": "42",
    "X-Lost-Plus-Email": "Allowed%40Example.COM",
    "X-Lost-Plus-Name": "%EB%A7%88%EB%A6%AC",
    "X-Lost-Plus-Role": "user",
    ...overrides
  });
}

// Decoding, the 80-character name cap and the fail-closed cases are the
// shared parser's contract and are tested in @lpfchan/gateway-identity.
// These tests cover what this call site adds on top.
describe("Common Auth gateway identity", () => {
  it("lower-cases the email and keeps the role the gateway vouched for", () => {
    const request = new Request("http://127.0.0.1:3000/api/me", { headers: gatewayHeaders() });
    expect(resolveGatewayIdentity(request)).toEqual({
      sub: "42",
      email: "allowed@example.com",
      name: "마리",
      role: "user"
    });
    expect(resolveGatewayIdentity(new Request("http://127.0.0.1:3000/api/me", {
      headers: gatewayHeaders({ "X-Lost-Plus-Role": "administrator" })
    }))?.role).toBe("administrator");
  });

  it("passes the parser's refusal through as null", () => {
    expect(resolveGatewayIdentity(new Request("http://127.0.0.1:3000/api/me"))).toBeNull();
    expect(resolveGatewayIdentity(new Request("http://127.0.0.1:3000/api/me", {
      headers: gatewayHeaders({ "X-Lost-Plus-Role": "owner" })
    }))).toBeNull();
  });
});

describe("MCP gateway identity", () => {
  it("grants Songbook's equal read/write permissions to a verified gateway identity", async () => {
    const result = await createGatewayMcpAuthAdapter().verifyRequest(
      new Request("http://127.0.0.1:3000/mcp", { headers: gatewayHeaders() }),
      ["songbook:write"]
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toEqual({ accessToken: "gateway-verified", scopes: ["songbook:read", "songbook:write"] });
      expect(result.principal).toEqual({ userId: "42", actor: { subject: "auth.lost.plus:42", email: "allowed@example.com", displayName: "마리" } });
    }
  });

  it("rejects a request without gateway identity", async () => {
    const result = await createGatewayMcpAuthAdapter().verifyRequest(new Request("http://127.0.0.1:3000/mcp"), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  });
});

describe("linked singer accounts", () => {
  it("acts under the linked singer's name and leaves other accounts alone", () => {
    const resolver = createCommonAuthRoleResolver(performerAccountsFromEnvironment({ PERFORMER_ACCOUNTS: '{"42":"eunhu"}' }));
    expect(resolver.resolve({ subject: "auth.lost.plus:42", email: "a@example.com", displayName: "Login Name" })?.displayName).toBe("은후");
    expect(resolver.resolve({ subject: "auth.lost.plus:7", email: "b@example.com", displayName: "Login Name" })?.displayName).toBe("Login Name");
    expect(resolver.resolve({ subject: "legacy-email:42", email: "c@example.com", displayName: "Login Name" })?.displayName).toBe("Login Name");
  });

  it("treats an unset secret as no links and refuses a malformed one", () => {
    expect(performerAccountsFromEnvironment({})).toEqual({});
    expect(() => performerAccountsFromEnvironment({ PERFORMER_ACCOUNTS: "nope" })).toThrow("JSON object");
    expect(() => performerAccountsFromEnvironment({ PERFORMER_ACCOUNTS: '["eunhu"]' })).toThrow("JSON object");
    expect(() => performerAccountsFromEnvironment({ PERFORMER_ACCOUNTS: '{"42":"bob"}' })).toThrow("unknown singer");
  });
});
