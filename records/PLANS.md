# Songbook Plans

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Accepted Directions

### Unified catalog-first surface

- Status: `implemented in source; production verification pending`.
- Main catalog owns account, filters, theme, sync, and the local-first search
  omnibar. TJ candidates follow saved matches after a 450 ms debounce and can
  be added inline. Manage/history remain contextual toolbar utilities.
- `/admin` remains a compatibility alias rather than a separate composition.
- Related ids: DEC-20260813-002, DEC-20260813-004.

### TJ-assisted discovery and entry

- Status: `implemented against the SQLite domain; live TJ smoke pending`.
- Exact lookup, bounded Unicode search, editable autofill, immediate add,
  duplicate outcomes, provenance, replay safety, and deleted-row restore are
  implemented behind authenticated same-origin actions.
- Manual entry remains the fallback for no-result, upstream, throttle, and
  parser-drift outcomes.
- Related ids: DEC-20260813-003.

### OCI single-server architecture

- Status: `implemented and locally verified; production release gates pending`.
- One OCI-hosted Node/Hono process serves the PWA, API, Better Auth, SQLite,
  TJ integration, health checks, and stateless MCP.
- Browser sessions and MCP bearer identity share Better Auth and recheck the
  current owner/editor allowlist for every protected request.
- Related ids: DEC-20260813-001, DEC-20260813-005.

## Remaining Rollout Sequence

1. Run the native OCI ARM64 image build, start, database health, and disk-space
   gate without changing live traffic.
2. Configure the final origin, Google callback, Better Auth secret, and
   owner/editor allowlist on the host.
3. Import and reconcile the Sheet snapshot into staging SQLite, inspect the
   dry-run and CSV recovery export, then obtain operator acceptance for the
   production import.
4. Prove scheduled backup, integrity checks, retention, and guarded restore on
   production-shaped paths.
5. Run the real external MCP client matrix, including PKCE, resource binding,
   stateless modern/legacy requests, scopes, revocation, and restart.
6. Smoke browser authentication, anonymous reads, protected writes, TJ flows,
   offline replay, multiple tabs, and service-worker cache behavior through the
   intended public hostname.
7. Publish a one-time GitHub Pages cleanup/redirect release that unregisters
   the old worker and clears old caches, then disable automatic Pages deploys.
8. With explicit operator authorization, switch the Cloudflare Tunnel/DNS to
   OCI and begin the observation window. Remove no legacy source during initial
   cutover.

## Deferred Work

- Real AI provider smoke tests remain deferred until provider credentials and
  cost/privacy acceptance exist.
- Cross-tab offline queue claiming remains deferred until the queue has durable
  lease-owner and lease-expiry fields with an atomic claim transaction.
- TJ add response replay should move duplicate detection behind the same
  idempotency record so repeated client request IDs return the original outcome.
- TJ parser maintenance and upstream compatibility review follow the fixed-host
  contract and parser-drift tests.

## Verification Ownership

- Data owner: accept importer reconciliation, rollback export, backup, restore,
  and the final production SQLite contents.
- Auth/MCP owner: verify exact origins/cookies, session lifecycle, allowlist
  revocation, OAuth discovery/PKCE/resource binding, and scoped stateless tools.
- Integration owner: verify native ARM64 packaging, Cloudflare Tunnel ingress,
  PWA cleanup, browser/TJ/offline behavior, rollback, and the observation
  window.
