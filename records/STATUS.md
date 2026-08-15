# Songbook Status

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Snapshot

- Last updated: 2026-08-15.
- Overall posture: `live in production on OCI single-server`.
- Production baseline: current `main` with single-role allowlist authorization,
  running as `songbook:local` (ARM64) on oci-ubuntu.
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

### TJ-assisted entry

- `packages/shared/src/tj.ts` defines bounded lookup/search/candidate
  contracts and parsing helpers.
- The single-server TJ adapter implements fixed-host fetching, bounded cache,
  throttling, parser-drift/upstream errors, exact lookup, and bounded search.
- Same-origin authenticated actions provide duplicate-safe immediate add
  through the SQLite domain service. Manual add/edit remains available.

### OCI single-server foundation

- One executable Hono server serves the built PWA, anonymous catalog API,
  protected browser API, Better Auth, health checks, and `/mcp`.
- SQLite owns domain, audit, idempotency, Better Auth, and MCP
  resource-binding state. Import/reconciliation, CSV recovery, backup,
  integrity-check, and guarded restore tools are checked in.
- Browser access uses same-origin HTTP-only sessions, exact-origin mutation
  checks, JSON-only bodies, and a per-request email allowlist. Every admitted
  user has the same `allowed` role and may delete songs.
- The offline performance queue drains on startup, reconnect, visibility, and
  authentication recovery, with bounded retry, dead letters, and preserved
  write identities.
- MCP uses stateless SDK v2 transport with legacy stateless fallback. Read and
  write scopes protect five tools, and authoritative Better Auth identity is
  resolved before the shared domain service executes.
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

- Cutover decision: `DEC-20260814-001`.
- Architecture decision: `DEC-20260813-005`.
- Reviewed refactor plan: `RSH-20260813-002`.
- OCI packaging and host procedure: `deploy/container/README.md`.
- Backup/restore procedure: `deploy/ops/README.md`.
