# DEC-20260820-002: Anonymous Public MCP With OAuth-Protected Song Operations

Opened: 2026-08-20 19-40-00 KST
Recorded by agent: codex-mcp-implementation

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260813-001, DEC-20260813-005, DEC-20260820-001

## Decision

Expose one stateless MCP surface at `/mcp`. Catalog, combined song search, and
song lookup are usable without a bearer credential. Performance recording,
performance cancellation, song creation, and song updates require an OAuth
bearer with `songbook:write`; song deletion requires `songbook:admin`.

The public search tool always searches saved songs locally. A valid
`songbook:read` OAuth request may continue through the existing bounded TJ
adapter for eligible queries, while anonymous requests never contact TJ.
Search returns one stable shape containing the query, saved results, and an
explicit TJ state.

Song creation is one tool. Manual fields and TJ provenance use the same
server-core mutation service and return structured created, duplicate, or
deleted outcomes. Browser cookies are not MCP identity; a request is
anonymous when it has no Authorization header, and any present malformed or
invalid Authorization header is rejected.

## Context

The earlier MCP surface required bearer authentication for every operation,
duplicated TJ discovery and add concepts, and selected transport authorization
from client-supplied method/name headers. That made public catalog access
unnecessarily dependent on OAuth and allowed malformed credentials to be
treated as anonymous. The website already has a local-first omnibar and a
shared SQLite mutation boundary that should define MCP behavior too.

## Options Considered

### Require OAuth for Every MCP Tool

- Upside: one simple transport gate
- Downside: public catalog reads cannot work for logged-out clients and search
  cannot provide a useful local-only fallback

### Keep Separate TJ Discovery and Add Tools

- Upside: small changes to the existing tool list
- Downside: MCP does not match the website omnibar and exposes two mutation
  paths that can drift in duplicate, provenance, and idempotency behavior

### Use Public Tools Plus OAuth-Scoped Operations With One Combined Search and Create Tool

- Upside: mirrors the website composition, keeps local reads available, and
  routes all writes through existing services
- Upside: one exported policy table controls both transport admission and tool
  guards
- Downside: anonymous routing must inspect the request body and preserve both
  modern and legacy stateless MCP behavior

## Rationale

The third option matches the product’s public catalog and trusted-group write
model without creating a second identity system. Body-derived routing avoids
trusting advisory headers, while invalid credentials remain failures instead
of silently losing authority. The shared TJ adapter, mirror, duplicate checker,
idempotency records, and domain services preserve existing operational safety.

## Consequences

- External clients must complete Better Auth OAuth discovery, registration,
  PKCE authorization, token issuance, and resource-bound bearer verification
  before using protected operations.
- Anonymous clients receive local saved-song search and explicit TJ skip
  metadata; they cannot trigger TJ traffic or mutations.
- The implementation remains un-deployed until the parent performs review,
  commit, deployment, and real external OAuth-client verification.
- The external client matrix remains an operational follow-up rather than an
  assumption derived from unit tests.
