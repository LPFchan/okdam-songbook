# DEC-20260914-001: Adopt auth.lost.plus for Browser and MCP Identity

Opened: 2026-09-14 02-26-17 KST
Recorded by agent: codex-orchestrator

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260820-002, DEC-20260820-003,
  DEC-20260822-001
- Supersedes: the application-owned Better Auth and MCP OAuth portions of
  DEC-20260820-002, DEC-20260820-003, and DEC-20260822-001

## Decision

Use `https://auth.lost.plus` as Songbook's browser and machine identity
authority. On every protected browser request, Songbook forwards the incoming
cookie to `/api/whoami`; on every authenticated MCP request, it forwards the
incoming bearer header. The returned identity is admitted when its service list
is empty or contains `okdam`.

Keep Songbook's one equal-permission `allowed` role. Every centrally admitted
identity may use the existing protected browser actions, and every admitted
shared bearer token receives the internal `songbook:read` and `songbook:write`
capabilities. Browser cookies remain ineligible as MCP credentials.

Retire Songbook's Better Auth routes, Google provider configuration, local
email-to-name allowlist, OAuth discovery and issuance endpoints, and local MCP
token-resource bindings. Protected MCP callers obtain and revoke bearer tokens
through the common-auth dashboard.

## Context

The fleet now has a common authentication service with one `.lost.plus` browser
cookie, one bearer-token system, immediate server-side revocation, and explicit
per-service admission. Keeping Songbook's separate Google sessions, allowlist,
and OAuth token database would duplicate identity and revocation state.

Songbook still needs its own authorization rules and public anonymous surfaces.
Common auth identifies and admits the caller; Songbook decides which actions
that identity may perform.

## Options Considered

### Keep Application-Specific Better Auth

- Upside: preserves automatic OAuth connection for external MCP clients
- Downside: retains a second login, account directory, token issuer, and
  revocation system

### Use Common Auth for Browsers but Keep Songbook OAuth for MCP

- Upside: keeps OAuth discovery for MCP clients
- Downside: machine and browser identities still depend on different account
  and token stores

### Use Common Auth for Browsers and MCP

- Upside: one identity and revocation authority for humans and machines
- Upside: removes Songbook-held auth secrets and account admission config
- Downside: MCP clients must be configured with a shared bearer token because
  common auth does not expose Songbook's former OAuth authorization flow

## Rationale

The third option completes the requested move to common auth and removes the
duplicated security-sensitive state. It preserves Songbook's public catalog,
anonymous MCP reads, exact-origin browser mutation checks, and one-role
authorization model.

## Consequences

- Signing in on any participating `.lost.plus` service signs the browser into
  Songbook when the account is visible to `okdam`.
- Signing out through Songbook ends the shared browser session everywhere.
- Shared bearer revocation takes effect on the next protected MCP request.
- Automatic MCP OAuth discovery, dynamic registration, PKCE, and refresh tokens
  are no longer served by Songbook.
- Historical performance names are read from the public-name snapshot stored
  when each performance was created; public catalog rows still expose no email.
