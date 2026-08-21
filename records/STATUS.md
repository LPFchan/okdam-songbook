# Songbook Status

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Snapshot

- Last updated: 2026-08-22 (country-only classification is live, `아니메` is
  normalized into `일본`, and public song statuses are `active` and `hold`;
  favorites are private to each signed-in account).
- Overall posture: `live in production on OCI single-server`.
- Production baseline: current `main` with single-role authorization and an
  exact email-to-public-name allowlist, running as `songbook:local` (ARM64) on
  oci-ubuntu.
- Public URL: https://okdam.lost.plus via the Cloudflare Tunnel
  (`obsidian-sync` tunnel, hostname `okdam.lost.plus` → `localhost:3010`).
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
  `http://localhost:3010`; the container port is localhost-only.
- Health: `/healthz` returns `{"ok":true}` locally and through the public
  hostname; the container healthcheck passes.
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
- The song form exposes original work, Korean readings, title romanization,
  title and artist aliases, country, assigned performers, multiple detailed key
  candidates, YouTube URL, active/hold status, and memo. It can generate
  schema-checked Korean-reading candidates, leaves them editable, and requires
  a separate save action.
- `오늘 불렀어요!` attributes one performance to the signed-in account. The
  detail sheet publicly shows the latest mapped name, timestamp, and shared
  count; unknown historical creators keep the timestamp-only display. The
  anonymous catalog exposes no email fields.
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
  protected browser API, Better Auth, health checks, and `/mcp`.
- SQLite owns domain, private favorites, audit, idempotency, Better Auth, and MCP
  resource-binding state. Import/reconciliation, CSV recovery, backup,
  integrity-check, and guarded restore tools are checked in.
- Browser access uses same-origin HTTP-only sessions, exact-origin mutation
  checks, JSON-only bodies, and a per-request email-to-public-name allowlist.
  Every admitted user has the same `allowed` role and may delete songs.
- The offline performance queue drains on startup, reconnect, visibility, and
  authentication recovery, with bounded retry, dead letters, and preserved
  write identities.
- MCP uses stateless SDK v2 transport with legacy stateless fallback. Public
  catalog/search/lookup operations work anonymously; every mutation requires
  `songbook:write`. Authoritative Better Auth identity is resolved before any
  authenticated request reaches the shared domain service, and anonymous
  search never invokes TJ.
- MCP/OAuth commit `3e8d623` is live. Production smoke verified protected
  resource and authorization-server discovery, anonymous tool listing and
  combined search, read/write-only scope metadata, missing/invalid bearer
  challenges, and local/public health.
- The Docker image runs non-root with a read-only root filesystem, persistent
  SQLite bind mount, localhost-only published port, bounded logs/resources,
  and an application-owned `/healthz` check.

## Deploying Changes

1. Commit and push to `main` (provenance-gated `LOG-*` commits).
2. On `oci-ubuntu`: `cd ~/okdam-songbook && git pull --ff-only`.
3. `docker compose -f compose.yaml -f deploy/container/compose.oci.yaml build
   songbook && docker compose -f compose.yaml -f deploy/container/compose.oci.yaml
   up -d songbook`.
4. Verify `curl http://127.0.0.1:3010/healthz` and
  `curl https://okdam.lost.plus/healthz` both return `{"ok":true}`.

## Remaining Verification

- Real external MCP client flow (discovery, dynamic registration where
  required, PKCE, token issuance/resource binding, initialize, tool listing,
  read call, scoped write, revocation, restart) through the public hostname.
- Live TJ lookup/search behavior through `okdam.lost.plus` beyond local
  adapter tests.
- Offline replay and multi-tab queue behavior on real devices.

## Rollback

- Re-run the compose deploy with the previous image tag or checkout, then
  verify `/healthz` before considering the rollback complete.
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
