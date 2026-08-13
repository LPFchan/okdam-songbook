# Songbook Status

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Snapshot

- Last updated: 2026-08-13.
- Overall posture: `OCI single-server source complete; release gates pending`.
- Integrated source baseline: commits through `c8bb6b1` (`Order clean-checkout
  verification`).
- Current product shape: one catalog-first main surface whose search input
  returns saved songs first and debounced TJ candidates second. Manage/history
  remain contextual utilities; `/admin` is a compatibility alias.
- Current production reality: no OCI cutover has been attempted. Existing
  external services remain untouched until the release gates and operator
  authorization are complete.
- Verification on the integrated source: clean `npm ci`, all 200 workspace
  tests, root typecheck, lint, ordered production builds, server
  start/health/shutdown smoke, and a complete read-only amd64 container health
  smoke pass.

## Integrated Source

### Unified web surface

- `apps/web/src/routes/PublicPage.tsx` owns the catalog omnibar, quick filters,
  account preferences, role-aware management entry points, and contextual
  management sheets.
- `apps/web/src/components/TjOmnibarResults.tsx` owns the debounced TJ
  continuation, local duplicate resolution, and inline immediate add state.
- `apps/web/src/routes/AdminPage.tsx` supplies add/manage/history content to
  the main surface. It is no longer a separate page composition.
- `/admin?tab=settings` is normalized away because the former Settings tab had
  no implemented operations.

### TJ-assisted entry

- `packages/shared/src/tj.ts` defines bounded lookup/search/candidate contracts
  and parsing helpers.
- The single-server TJ adapter implements fixed-host fetching, bounded cache,
  throttling, parser-drift/upstream errors, exact lookup, and bounded search.
- Same-origin authenticated actions provide duplicate-safe immediate add and
  owner restore through the SQLite domain service. Manual add/edit remains
  available.
- Live TJ behavior through the final OCI hostname has not been smoke-tested.

### OCI single-server foundation

- One executable Hono server serves the built PWA, anonymous catalog API,
  protected browser API, Better Auth, health checks, and `/mcp`.
- SQLite owns domain, audit, idempotency, Better Auth, and MCP resource-binding
  state. Import/reconciliation, CSV recovery, backup, integrity-check, and
  guarded restore tools are checked in.
- Browser access uses same-origin HTTP-only sessions, exact-origin mutation
  checks, JSON-only bodies, and a per-request owner/editor allowlist.
- The offline performance queue drains on startup, reconnect, visibility, and
  authentication recovery, with bounded retry, dead letters, and preserved
  write identities.
- MCP uses stateless SDK v2 transport with legacy stateless fallback. Read and
  write scopes protect five tools, and authoritative Better Auth identity is
  resolved before the shared domain service executes.
- The Docker image runs non-root with a read-only root filesystem, persistent
  SQLite bind mount, localhost-only published port, bounded logs/resources,
  and an application-owned `/healthz` check.

## Release Gates

1. Build and start the image natively on the OCI ARM64 host and pass `/healthz`;
   the successful local amd64 build is not ARM64 evidence.
2. Configure the final origin, Google callback, strong Better Auth secret, and
   non-empty owner/editor allowlist without committing their values.
3. Import the source Sheet repeatedly into a staging SQLite database, reconcile
   counts/relations/duplicates, export recovery CSV, and obtain operator
   acceptance before the production import.
4. Run an integrity-checked backup and restore drill using production-shaped
   paths and retention.
5. Complete a real external MCP client flow: discovery, dynamic registration
   where required, PKCE authorization, token issuance/resource binding,
   initialize, tool listing, read call, scoped write, revocation, and restart.
6. Prepare and verify the old GitHub Pages service-worker cleanup and redirect
   artifact before removing Pages or its legacy data paths.
7. Run browser, TJ, offline replay, cache, auth, and MCP smoke tests through the
   final Cloudflare Tunnel hostname.
8. Perform deployment, tunnel/DNS changes, and cutover only with explicit
   operator authorization. Retain the legacy source and rollback route during
   the observation window.

## Rollback

- Restore the last integrity-checked SQLite backup into a stopped service, then
  start and verify locally before restoring public traffic.
- Keep the previous container image and Cloudflare Tunnel route available
  during the observation window.
- Preserve the legacy external source for at least the accepted observation
  period; do not delete it as part of initial cutover.

## Evidence

- Architecture decision: `DEC-20260813-005`.
- Reviewed refactor plan: `RSH-20260813-002`.
- OAuth compatibility spike and remaining external-client gate:
  `RSH-20260813-003`.
- OCI packaging and host procedure: `deploy/container/README.md`.
