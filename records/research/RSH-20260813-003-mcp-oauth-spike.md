# RSH-20260813-003: Better Auth MCP OAuth and Stateless SDK Spike

Opened: 2026-08-13 19-19-33 KST
Recorded by agent: oauth-spike3

## Question

Can Better Auth's MCP provider and the installed MCP TypeScript SDK v2 provide
Songbook's headless OAuth flow, custom scopes, resource binding, bearer-only
enforcement, and stateless 2026-07-28 plus legacy 2025 MCP handling on an OCI
single server?

## Evidence

### Better Auth provider

Using `better-auth@1.6.27`, `better-auth/plugins` `mcp()`, Node 22's temporary
`DatabaseSync(':memory:')`, and the provider's `getMigrations()`:

- The plugin creates the required `oauthApplication`, `oauthAccessToken`, and
  `oauthConsent` tables alongside normal Better Auth tables.
- `GET /api/auth/.well-known/oauth-authorization-server` returns 200 and
  advertises authorize, token, JWKS, and dynamic registration endpoints.
- `GET /api/auth/.well-known/oauth-protected-resource` returns 200 and carries
  the configured `resource` and custom `songbook:read`, `songbook:write`, and
  `songbook:admin` scopes.
- A signed-up user session plus `POST /api/auth/mcp/register` (with an Origin
  header) creates a public PKCE client. Registration without Origin is rejected
  by Better Auth's origin protection.
- A complete headless authorization-code flow succeeded: session cookie →
  dynamic client registration → S256 challenge → authorization redirect with
  code/state → token exchange. The returned token had the requested
  `openid songbook:read songbook:write` scope.

The important gaps are concrete:

- Authorization-server discovery returned only
  `openid`, `profile`, `email`, and `offline_access` in `scopes_supported`,
  even though the plugin was configured with the three Songbook scopes. The
  protected-resource document did return the custom scopes. Production code
  must override/fix the authorization metadata before clients can reliably
  discover the scopes.
- Better Auth's plugin stores an opaque access token with client/user/scope and
  expiry fields, but the token exchange does not bind an RFC 8707 resource
  audience. A resource-server verifier must therefore reject tokens unless the
  application adds an explicit audience/resource record or uses an issuer/token
  strategy that carries and checks it. Do not infer audience from client ID.
- The Better Auth plugin's own OAuth routes are under the auth base path
  (`/api/auth/mcp/*`) while the MCP resource is `/mcp`. Required public aliases
  and exact discovery paths need an explicit server routing decision.

### MCP SDK v2

Using `@modelcontextprotocol/server@2.0.0`:

- `oauthMetadataResponse()` serves the path-aware protected-resource document at
  `/.well-known/oauth-protected-resource/mcp` and the authorization-server
  document at `/.well-known/oauth-authorization-server`. It does not serve the
  unqualified root protected-resource path when the resource is `/mcp`.
- `requireBearerAuth()` rejects missing Authorization, cookie-only requests,
  malformed non-Bearer headers, unknown/expired tokens, and insufficient scopes
  with the expected 401/403 challenge responses. It verifies expiration and
  enforces required scopes. It does not itself check `AuthInfo.resource`; the
  application verifier must enforce audience/resource binding.
- `checkResourceAllowed()` correctly rejects a different origin and accepts the
  configured resource path; this is a reusable verifier check.
- `createMcpHandler(factory, { legacy: 'stateless' })` is explicitly designed
  for a fresh per-request server and serves legacy stateless 2025 traffic.
- The 2026-07-28 path is envelope-based and has no `initialize` handshake.
  A valid `server/discover` request needs the reserved `_meta` envelope plus
  `Mcp-Method`; the handler returned 200 with `supportedVersions: ["2026-07-28"]`.
  An `initialize` request carrying a modern protocol header is correctly
  rejected as a header/body-era mismatch. This is a client/protocol test gate,
  not evidence that an existing external client supports the modern wire.

## Go/No-Go

### Conditional no-go for production OAuth/MCP implementation

Do not start production MCP implementation or cut over based solely on the
installed packages. The OAuth flow and SDK primitives are viable, but launch
is blocked until the server design proves all of the following in reusable
tests:

1. Authorization-server discovery advertises the exact custom scopes.
2. Every minted/introspected token has an audience/resource binding equal to
   the canonical `https://<host>/mcp` resource, and the resource server rejects
   a wrong audience.
3. OAuth route aliases and both required discovery paths are explicit and
   tested (the Better Auth auth-base routes and the path-aware SDK route differ).
4. Bearer-only MCP routing never falls back to browser cookies, including when
   both cookie and bearer headers are present.
5. A real target MCP client completes discovery, PKCE authorization, token
   exchange, and one 2026 and/or legacy MCP call. The external client test is an
   operator gate and cannot be replaced by this headless probe.

The platform choice remains viable: custom scopes can be minted, SQLite works,
and MCP v2 stateless serving is available. The correct next implementation is
an application-owned OAuth/resource-server adapter around Better Auth's stable
database/provider pieces, with a narrow compatibility shim for discovery and
resource-bound token verification. Treat Better Auth's `@better-auth/mcp`
package as unrelated diagnostics tooling, not the OAuth provider.

## Rejected shortcuts

- Do not claim audience safety because the protected-resource metadata contains
  `resource`; metadata does not bind opaque tokens.
- Do not expose only the SDK's path-aware protected-resource alias and assume
  clients will probe the auth plugin's root path, or vice versa.
- Do not use browser session cookies as MCP credentials.
- Do not report MCP 2026 support from an `initialize` request; modern clients
  use the envelope and `server/discover` path.

## Reproduction surface

All evidence was produced with temporary inline Node scripts in the isolated
worker worktree; no production MCP server, database, deployment, or files were
changed. Package versions are those pinned by the worktree lockfile.
