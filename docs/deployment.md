# Deployment

Production is the OCI single server at https://okdam.lost.plus. The legacy
GitHub Pages / Apps Script / Cloudflare Worker stack is retired: the Pages
workflow is a manual-dispatch redirect stub and nothing deploys automatically.

The anonymous MCP and OAuth-protected operations from commit `b8ca145` are live.
Production smoke verifies the protected-resource challenge, Better Auth OAuth
discovery, anonymous listing/search, invalid-token handling, and local/public
health. Interactive PKCE login, resource-bound token calls, revocation, restart,
and the modern/legacy external-client matrix remain open.

## Current production components

- `oci-ubuntu` (Oracle Cloud always-free ARM64) runs the Dockerized app as
  container `okdam-songbook-songbook-1`, image `songbook:local`.
- The repo checkout lives at `/home/ubuntu/okdam-songbook` on the host.
- `deploy/container/compose.oci.yaml` (host-local, untracked) overrides the
  published port to `127.0.0.1:3010:3000`; `deploy/container/songbook.env`
  (host-local, untracked) carries the origin, Google OAuth client, Better
  Auth secret, and JSON email allowlist.
- Cloudflare Tunnel `obsidian-sync` routes `okdam.lost.plus` to
  `http://localhost:3010` via `/etc/cloudflared/config.yml`; the container
  port is localhost-only.
- SQLite lives at `/var/lib/songbook/songbook.sqlite` on the host, bind
  mounted into the container.
- `songbook-backup.timer` (systemd, user `opc`) runs
  `/opt/songbook/scripts/ops/backup-sqlite.sh` daily at 03:15 UTC, writing
  checksummed archives to `/var/backups/songbook`. A restore drill completed
  on 2026-08-13; see `deploy/ops/README.md`.

## Deploying a change

1. Commit on `main` using the provenance-gated `LOG-*` message flow and
   push to `origin`.
2. On the host: `cd ~/okdam-songbook && git pull --ff-only`.
3. Rebuild and restart:
   ```
   docker compose -f compose.yaml -f deploy/container/compose.oci.yaml build songbook
   docker compose -f compose.yaml -f deploy/container/compose.oci.yaml up -d songbook
   ```
4. Verify `curl http://127.0.0.1:3010/healthz` and
   `curl https://okdam.lost.plus/healthz` both return `{"ok":true}`, and
   that `docker ps` reports the container healthy.
5. For an MCP release, verify `/.well-known/oauth-protected-resource/mcp`,
   authorization-server discovery, anonymous public calls, protected-tool
   OAuth, invalid-token challenges, and the external client matrix before
   calling the release complete.

The image builds natively on the ARM64 host; never push an amd64-built image
to production.

## Rollback

Redeploy the previous checkout or image with the same compose commands, then
verify `/healthz` before considering the rollback complete. For data
recovery, restore the latest integrity-checked archive from
`/var/backups/songbook` into a stopped service per `deploy/ops/README.md`,
verifying no `-wal`/`-shm` sidecars remain.

## Retired legacy path (reference only)

The GitHub Pages static app, Apps Script private Sheet, and Cloudflare Worker
ChatGPT OAuth Action were the production topology before 2026-08-13. The
setup steps that used to live here (Pages variables, clasp Script Properties,
D1/Worker secrets) no longer apply to production. Keep the legacy source
available for the observation window recorded in `DEC-20260813-005`; removal
is a separate operator decision.
