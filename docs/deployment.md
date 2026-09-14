# Deployment

Production is the OCI single server at https://okdam.lost.plus. The legacy
GitHub Pages / Apps Script / Cloudflare Worker stack is retired: the Pages
workflow is a manual-dispatch redirect stub and nothing deploys automatically.

Public MCP operations remain anonymous. Protected browser and MCP requests use
`auth.lost.plus`; the shared bearer revocation and modern/legacy MCP client
matrix must be verified after auth-related releases.

## Current production components

- `oci-ubuntu` (Oracle Cloud always-free ARM64) runs the Dockerized app as
  container `okdam-songbook-songbook-1`, image `songbook:local`.
- The repo checkout lives at `/home/ubuntu/okdam-songbook` on the host.
- `deploy/container/compose.oci.yaml` (host-local, untracked) overrides the
  published port to `127.0.0.1:3010:3000`; `deploy/container/songbook.env`
  (host-local, untracked) carries the public origin and optional AI
  configuration.
- Cloudflare Tunnel `obsidian-sync` routes `okdam.lost.plus` to the Common Auth
  gateway at `http://localhost:8740`; the gateway reaches the container's
  localhost-only port at `http://localhost:3010`.
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
   Before the first release containing migration
   `0107_immutable_account_ownership`, stop the restarted container, back up
   both `/var/lib/songbook/songbook.sqlite` and `/var/lib/auth/auth.db`, and
   map each `legacy-email:<normalized-email>` favorite owner to
   `auth.lost.plus:<users.id>` by joining the two databases on normalized
   email. Abort on an unmatched or duplicate email, then restart. This is a
   one-time offline data migration; never let a runtime request claim a legacy
   owner from an email address.
4. Verify `curl http://127.0.0.1:3010/healthz` and
   `curl https://okdam.lost.plus/healthz` both return healthy responses, and
   that `docker ps` reports the container healthy.
5. For an auth or MCP release, verify shared-cookie identity, path-preserving
   login, anonymous public calls, a protected tool with a shared bearer, an
   invalid-token challenge, a visibility-restricted bearer rejection, token
   revocation, and the external client matrix
   before calling the release complete.

The image builds natively on the ARM64 host; never push an amd64-built image
to production.

## Rollback

Follow the release-specific, schema-aware procedure in
`records/STATUS.md#rollback`. It identifies which image and database snapshot
form a compatible pair, when the current database may be reused, and when
post-cutover writes must be quarantined and reconciled. Use
`deploy/ops/README.md` for the guarded restore mechanics. Verify an affected
favorite or idempotent operation as well as `/healthz` before declaring the
rollback complete.

## Retired legacy path (reference only)

The GitHub Pages static app, Apps Script private Sheet, and Cloudflare Worker
ChatGPT OAuth Action were the production topology before 2026-08-13. The
setup steps that used to live here (Pages variables, clasp Script Properties,
D1/Worker secrets) no longer apply to production. Keep the legacy source
available for the observation window recorded in `DEC-20260813-005`; removal
is a separate operator decision.
