# Songbook Status

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Snapshot

- Last updated: 2026-09-14 (browser and MCP credentials are now validated by
  the local Common Auth gateway; the private server consumes verified identity).
- Overall posture: `live in production on OCI single-server`.
- Production baseline: `0943067` with gateway identity and single-role
  Songbook authorization, running as `songbook:local` (ARM64) on oci-ubuntu.
- Public URL: https://okdam.lost.plus via the Cloudflare Tunnel
  (`obsidian-sync` tunnel, hostname `okdam.lost.plus` → the OCI Common Auth
  gateway on `localhost:8740` → private Songbook on `localhost:3010`).
- Current product shape: one catalog-first main surface whose search input
  returns saved songs first and debounced TJ candidates second. Manage/history
  remain contextual utilities; `/admin` is a compatibility alias.
- Scheduled backups run daily at 03:15 UTC via `songbook-backup.timer`
  (systemd, user `opc`, script `/opt/songbook/scripts/ops/backup-sqlite.sh`),
  writing checksummed SQLite archives to `/var/backups/songbook` with a
  completed restore drill on 2026-08-13.
- The legacy GitHub Pages/Apps Script/Worker stack remains retired: the Pages
  workflow is a manual-dispatch redirect stub and the OCI server is the only
  production path.

## Production Deployment

- Host: `oci-ubuntu` (Oracle Cloud always-free ARM64).
- Compose: `compose.yaml` plus the host-local override
  `deploy/container/compose.oci.yaml` (publishes `127.0.0.1:3010:3000`;
  the override and `deploy/container/songbook.env` live on the host only).
- Database: `/var/lib/songbook/songbook.sqlite` bind-mounted into the
  container, with WAL sidecars managed by the backup script.
- Ingress: Cloudflare Tunnel `obsidian-sync` routes `okdam.lost.plus` to
  `http://localhost:8740`; the gateway routes to the localhost-only container
  port at `127.0.0.1:3010`.
- Health: `/healthz` returns `{"ok":true}` locally and through the public
  hostname; the container healthcheck passes.
- Shared auth: `https://auth.lost.plus/api/ready` is healthy. The Node server
  has no Auth origin or credential validator; the gateway admits `okdam`
  browser sessions and `okdam-mcp` machine tokens.
- Korean-reading generation uses Cloudflare Workers AI with
  `@cf/google/gemma-4-26b-a4b-it`; its server-only credential is not bundled
  into the web application.
- Recent motion fixes: topbar spring commit behavior and bottom-sheet release
  overscroll are calm in production (commits `d7cc3ca`…`86dd9b3`); the
  release-path CSS transform transition that fought the return spring is gone,
  and iOS Add-to-Home-Screen opens standalone via the new meta tags.

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
- The single-server TJ adapter implements fixed-host fetching, a persistent
  SQLite mirror with 24-hour exact-query freshness, throttling,
  parser-drift/upstream errors, exact lookup, and bounded search.
- The mirror is wired to the same SQLite handle as the application. It grows
  only from searches, retains normalized songs indefinitely, records stale
  refresh attempts/failures, and serves the previous snapshot when a refresh
  fails. Pages are independent; a future combined-paging surface must handle
  mixed-age seams.
- Same-origin authenticated actions provide duplicate-safe immediate add
  through the SQLite domain service. TJ adds reuse a known artist's country
  when possible, then infer it from the title and artist writing systems.
  Manual add/edit remains available.

### OCI single-server foundation

- One executable Hono server serves the built PWA, anonymous catalog API,
  protected browser API, health checks, and `/mcp`.
- SQLite owns domain, private favorites, audit, idempotency, and TJ mirror
  state. Migration `0106_drop_mcp_token_resources` is applied in production;
  migration `0107_immutable_account_ownership` is ready for the next release
  and moves favorites/idempotency from mutable email to Common Auth subject.
  The retired local token table is absent. Import/reconciliation, CSV recovery,
  backup, integrity-check, and guarded restore tools are checked in.
- Browser access uses the shared `lp_auth` cookie. The local gateway validates
  it at `auth.lost.plus`, enforces `okdam` service admission, strips the cookie,
  and supplies verified identity headers. Songbook retains exact-origin
  mutation checks and JSON-only bodies. Every admitted user has the same
  `allowed` role and may delete songs.
- Favorites and idempotency are keyed by the namespaced immutable Common Auth
  subject. Email and public name remain historical attribution snapshots and
  can change without transferring private state.
- The offline performance queue drains on startup, reconnect, visibility, and
  authentication recovery, with bounded retry, dead letters, and preserved
  write identities.
- MCP uses the gateway's `okdam-mcp` token scope and stateless SDK v2 transport
  with legacy stateless fallback. Public
  catalog/search/lookup operations work anonymously; every mutation requires
  `songbook:write`. Authoritative common-auth identity is resolved before any
  authenticated request reaches the shared domain service, and anonymous
  search never invokes TJ. Browser cookies alone never grant MCP identity.
- Common-auth production smoke verified the public shell and catalog, API
  `401` versus navigation redirect behavior, gateway logout, anonymous MCP
  listing, protected anonymous rejection, invalid-token rejection, a valid
  protected MCP call, auth readiness, and local/public health.
- The Docker image runs non-root with a read-only root filesystem, persistent
  SQLite bind mount, localhost-only published port, bounded logs/resources,
  and an application-owned `/healthz` check.

## Deploying Changes

1. Commit and push to `main` (provenance-gated `LOG-*` commits).
2. On `oci-ubuntu`: `cd ~/okdam-songbook && git pull --ff-only`.
3. Run `scripts/ops/backup-sqlite.sh` and verify the reported archive with
   `scripts/ops/check-backup.sh` before replacing the image.
4. `docker compose -f compose.yaml -f deploy/container/compose.oci.yaml build
   songbook && docker compose -f compose.yaml -f deploy/container/compose.oci.yaml
   up -d songbook`.
5. Verify `curl http://127.0.0.1:3010/healthz` and
  `curl https://okdam.lost.plus/healthz` both return `{"ok":true}`.

## Remaining Verification

- Shared browser cookie with path-preserving login/logout and a protected write
  through the public hostname.
- Real shared-bearer MCP flow: valid token, `okdam` admission, protected read
  and write, revocation, and modern/legacy restart behavior.
- Live TJ lookup/search behavior through `okdam.lost.plus` beyond local
  adapter tests.
- Offline replay and multi-tab queue behavior on real devices.

## Rollback

- Migration `0107_immutable_account_ownership` changes favorite ownership from
  `user_email` to `user_subject` and idempotency ownership from `actor_email`
  to `actor_subject`. Images before commit `fc907a0` cannot use a database that
  has crossed this boundary; `/healthz` alone does not exercise the affected
  queries.
- The pinned pre-0107 pair on `oci-ubuntu` is checkout `54c6830`, local image
  `songbook:rollback-54c6830` (digest
  `sha256:9a281fe2004869fe8adbba9e85054b1572ab2c02d3b95809b24d785d92a4b743`),
  and archive
  `/var/backups/songbook/releases/songbook-20260914T032208Z-3611991.sqlite.gz`.
  Its checksum, SQLite integrity, old ownership columns, and image boot against
  a restored copy were verified on 2026-09-15.
- A rollback between images that both include migration 0107 may reuse the
  current database. Verify a favorite or idempotent operation as well as
  `/healthz` before declaring it complete.
- To cross back before migration 0107, stop the service first and create a
  separate quarantine backup of the current post-cutover database. Restore the
  pinned archive with `scripts/ops/restore-sqlite.sh` and deploy only its paired
  image/checkout. The snapshot predates migration 0107, so writes accepted
  after it require explicit reconciliation. If those writes cannot be
  discarded or migrated, keep the post-0107 schema and roll forward.
- For data recovery, restore the latest integrity-checked archive from
  `/var/backups/songbook` into a stopped service per
  `deploy/ops/README.md`, verifying no `-wal`/`-shm` sidecars remain.

## Evidence

- Performance identity decision: `DEC-20260821-001`.
- Cutover decision: `DEC-20260814-001`.
- Architecture decision: `DEC-20260813-005`.
- Reviewed refactor plan: `RSH-20260813-002`.
- OCI packaging and host procedure: `deploy/container/README.md`.
- Backup/restore procedure: `deploy/ops/README.md`.
