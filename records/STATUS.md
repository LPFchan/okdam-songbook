# Songbook Status

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Snapshot

- Last updated: 2026-09-19 (post-cutover audit: Workers runtime fixed, OCI
  packaging removed from the repo).
- Overall posture: `live in production on Cloudflare Workers`.
- Where it runs: Worker `okdam-songbook` (account `f6f0cfde…`), route-less,
  over D1 `okdam-songbook` (APAC, `9b353a3b-…`) and Workers Assets built from
  `apps/web/dist`. It is reachable only through the `auth-gateway` Worker's
  `SONGBOOK_BACKEND` service binding.
- How it is reached: zone route `okdam.lost.plus/*` → `auth-gateway`. The
  gateway validates the credential against the hub, strips
  `Authorization`/`x-api-key`/cookies, and forwards over the binding with
  `x-lost-plus-{sub,email,name,role,encoding}` injected. Its route table for
  this host (`auth/gateway/config/cloudflare.gateway.json`):
  `/mcp` mcp (visibility `okdam`, token scope `okdam-mcp`), `/api/catalog`
  GET/HEAD public, `/api` oauth, `/_auth/logout` oauth (answered by the
  gateway itself), `/` public.
- What the app trusts: only the injected identity headers
  (`apps/server/src/auth.ts`). It validates no credential and calls no auth
  origin. A request on a protected path without a complete, percent-encoded
  identity is refused (401); `/` and `GET /api/catalog` are anonymous by
  policy and arrive with no identity headers.
- State: D1 holds songs, performances, private favorites, audit events,
  idempotency keys, and the TJ mirror. Schema is `apps/worker/migrations/
  0001_init.sql`, recorded as applied in D1's `d1_migrations` table
  (`migrations_dir` is declared in `wrangler.toml`). Every song and
  performance row was verified identical to the OCI SQLite on 2026-09-19.
- Verified live on 2026-09-19 after the audit deploy: `/` and `/admin` 200
  serving the shell with `X-Frame-Options: DENY`, `/api/catalog` 200 with 126
  songs, `/api/me` 401 (302 to `auth.lost.plus/login` with an HTML `Accept`),
  `/mcp` initialize 200 on 2025-03-26, 2025-06-18 and 2026-07-28, a
  2026-07-28 `tools/list` carrying `ttlMs: 300000` / `cacheScope: private`,
  no bearer and bogus bearer 401 with a `WWW-Authenticate` challenge.
- The OCI container, images and compose network were removed on 2026-09-18.
  The repo's container packaging (Dockerfile, compose, `deploy/`,
  `scripts/ops/`, the Node entry point) was removed on 2026-09-19. What
  remains on `oci-ubuntu` is data only: `/var/lib/songbook/songbook.sqlite`
  (127 songs, last write 2026-08-26) and the archives under
  `/var/backups/songbook`, plus a `songbook-backup.timer` that still fires
  against that static file. See "OCI leftovers" below.
- Current product shape: one catalog-first main surface whose search input
  returns saved songs first and debounced TJ candidates second. Manage/history
  remain contextual utilities; `/admin` is a compatibility alias served by
  the SPA fallback.

## Production Deployment

### Cloudflare Workers (serving)

- Worker: `okdam-songbook`, `workers_dev = false`, no `[[routes]]`. Deploying
  replaces the route list with what `wrangler.toml` says, so it must stay
  route-less; the gateway holds the zone route.
- Assets: `[assets]` with `run_worker_first = true`, so every request passes
  through the Worker and HTML responses carry the frame-denial headers.
  Unknown non-server paths fall back to `index.html`; `/api`, `/mcp` and
  `/.well-known` never do.
- Database: D1 `okdam-songbook`. No interactive transactions: statements run
  immediately and `transaction()` is a pass-through. A mutation that throws
  releases its idempotency claim by hand so a retry reruns rather than
  reporting "still processing".
- AI readings: `AI_ENDPOINT` and `AI_MODEL` in `[vars]`,
  `CLOUDFLARE_AI_API_TOKEN` as a Worker secret. All three or none.
- Node.js compatibility is on by default at this compatibility date; no flag.

### Deploying changes

1. Commit and push to `main` (provenance-gated `LOG-*` commits).
2. `npm run build` at the repo root (builds shared, server-core, mcp, admin,
   server, web).
3. `cd apps/worker && npm run deploy` (fetches the deploy token from passage,
   `infra` / `CF_MASTER_TOKEN`). Expect `No targets deployed` — that is the
   route-less shape.
4. Verify through the public hostname (see `docs/deployment.md` for the
   commands): `/healthz`, `/api/catalog`, `/admin` with frame headers,
   `/api/me` 401, `/mcp` initialize with an `okdam-mcp` token, bogus bearer
   401.

### Rollback

- Code: `wrangler rollback` (or `wrangler deployments list` then
  `wrangler rollback <version-id>`) restores the previous Worker version in
  seconds. Assets and code roll back together.
- Data: D1 Time Travel restores the database to any point in the last 30
  days (`wrangler d1 time-travel info|restore okdam-songbook`). Take a
  `wrangler d1 export` before any migration.
- Schema: migrations are append-only under `apps/worker/migrations/`; a
  rollback that crosses a migration needs a Time Travel restore first.
- There is no container to fall back to. The OCI SQLite predates every write
  made on Workers and is an archive, not a rollback target.

### OCI leftovers (data only, torn down on 2026-09-18)

- `/var/lib/songbook/songbook.sqlite` and the `.pre-*` copies beside it;
  `/var/backups/songbook/*.sqlite.gz` and `releases/`; systemd units
  `songbook-backup.service` / `.timer` under `/etc/systemd/system` with the
  script at `/opt/songbook/scripts/ops/backup-sqlite.sh`; the
  `okdam.lost.plus` entry in `/etc/cloudflared/config.yml` and in the local
  gateway config, both inert behind the Worker route; the host-local
  `deploy/container/{compose.oci.yaml,songbook.env}` in the checkout (the env
  file holds the AI token). All of it can be archived and removed; nothing
  reads it.

## Product Surface

### Unified web surface

- `apps/web/src/lib/components/CatalogPage.svelte` owns the catalog omnibar,
  quick filters, account preferences, role-aware management entry points, and
  contextual management sheets (`BottomSheet.svelte` with spring-driven drag).
- `apps/web/src/lib/components/TjOmnibar.svelte` owns the debounced TJ
  continuation, local duplicate resolution, and inline immediate add state.
- `/admin` supplies add/manage/history content to the main surface as a
  compatibility alias rather than a separate page composition.
- The song form generates schema-checked Korean-reading candidates for the
  title and artist, leaves them editable, and requires a separate save action.
- `오늘 불렀어요!` attributes one performance to the signed-in account. The
  detail sheet publicly shows the latest stored public-name snapshot,
  timestamp, and shared count. The anonymous catalog exposes no email fields.
- The catalog heart writes a private account-to-song favorite relationship.
  Each account sees only its own favorite IDs through the protected API, and
  the favorite-only chip requires login. Anonymous catalog reads contain no
  favorite state.

### TJ-assisted entry

- `packages/shared/src/tj.ts` defines bounded lookup/search/candidate
  contracts and parsing helpers.
- The TJ adapter (`packages/server-core/src/domain/tj.ts`) implements
  fixed-host fetching, a persistent D1 mirror with 24-hour exact-query
  freshness, throttling, parser-drift/upstream errors, exact lookup, and
  bounded search. The adapter is built once per Worker isolate, so its
  throttle and in-flight dedup hold within an isolate and not across them.
- The mirror grows only from searches, retains normalized songs indefinitely,
  records stale refresh attempts/failures, and serves the previous snapshot
  when a refresh fails.
- Same-origin authenticated actions provide duplicate-safe immediate add
  through the domain service. TJ adds reuse a known artist's country when
  possible, then infer it from the title and artist writing systems. Manual
  add/edit remains available.

### Application shape

- `apps/server` is the Hono application (API, `/healthz`, `/mcp`) that
  `apps/worker` mounts. It is no longer a runnable server; the only entry
  point is the Worker.
- Browser access uses the shared `lp_auth` cookie. The gateway validates it
  at the hub, enforces `okdam` service admission, strips the cookie, and
  supplies verified identity headers. Songbook retains exact-origin mutation
  checks and JSON-only bodies. Every admitted user has the same `allowed`
  role and may delete songs.
- Favorites and idempotency are keyed by the namespaced immutable Common Auth
  subject (`auth.lost.plus:<sub>`). Email and public name remain historical
  attribution snapshots and can change without transferring private state.
- The offline performance queue drains on startup, reconnect, visibility, and
  authentication recovery, with bounded retry, dead letters, and preserved
  write identities.
- MCP uses the gateway's `okdam-mcp` token scope and the stateless
  `@modelcontextprotocol/server` v2 handler with the legacy stateless
  fallback, so 2025-03-26, 2025-06-18 and 2026-07-28 clients all initialize.
  Every MCP request requires verified gateway identity; read tools require
  `songbook:read` and mutations require `songbook:write`. The tool list is
  advertised as cacheable for five minutes (`private`).

## Remaining Verification

- Shared browser cookie with path-preserving login/logout and a protected
  write through the public hostname, on a real device.
- Offline replay and multi-tab queue behavior on real devices.
- Live TJ lookup/search through `okdam.lost.plus` beyond adapter tests.

## Evidence

- Workers cutover and audit: `DEC-20260919-001`.
- Cloud gateway decision: `DEC-20260918-001`.
- Common Auth adoption and gateway trust: `DEC-20260914-001`,
  `DEC-20260914-002`.
- Performance identity decision: `DEC-20260821-001`.
- Deploy, verify and rollback procedure: `docs/deployment.md`.
