# DEC-20260914-002: Trust the Local Common Auth Gateway

Opened: 2026-09-14 22-17-24 KST
Recorded by agent: root

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Supersedes: DEC-20260914-001 for the live request boundary
- Related ids: DEC-20260820-002, DEC-20260820-003

## Decision

Put every live Songbook request through the Common Auth gateway on OCI.
Keep the catalog and application shell public, protect browser APIs with the
gateway's `oauth` policy, and expose `/mcp` through its explicitly anonymous
MCP policy with the `okdam-mcp` token scope.

The Node server trusts only the gateway's percent-encoded identity headers.
It no longer forwards cookies or bearer tokens to auth.lost.plus. Songbook
continues to own tool permissions, user roles, JSON validation, exact-origin
mutation checks, and anonymous MCP method/tool admission.

## Context

Songbook previously contained its own Common Auth HTTP client for both browser
sessions and MCP bearer tokens. The per-machine gateway now owns those shared
credential checks for every service on OCI, so retaining the client would
duplicate the security-sensitive behavior this architecture centralizes.

## Options Considered

### Keep Direct Validation In Songbook

- Upside: no backend change
- Downside: cookie and token behavior remains duplicated
- Downside: gateway and application can disagree about failure semantics

### Trust Gateway Identity And Keep Domain Authorization

- Upside: one credential validator and one service-specific authorization layer
- Upside: revocation still takes effect on the next request
- Downside: the backend port must remain private

## Rationale

The local gateway already strips untrusted identity and credentials before it
adds verified identity. Songbook only needs the resulting account to decide
which application actions are allowed.

## Consequences

- Cloudflare ingress for okdam.lost.plus terminates at the OCI gateway.
- The Node port remains bound to loopback.
- Browser logout uses the gateway-owned `/_auth/logout` route.
- Anonymous MCP transport still reaches Songbook without identity; explicit
  invalid credentials are rejected before the backend.
- Authenticated MCP callers use the `okdam-mcp` machine-token scope.
