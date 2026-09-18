# Deployment

Songbook runs in two interchangeable production topologies. Both serve the
same Hono application, the same API surface, and the same PWA; only the
database driver and process model differ.

## OCI (current production)

The OCI single server at https://okdam.lost.plus runs the Dockerized Node/Hono
app on oci-ubuntu. See `deploy/ops/README.md` for container operations,
backups, and the restore drill.

1. Commit on `main` and push to `origin`.
2. On the host: `cd ~/okdam-songbook && git pull --ff-only`.
3. Rebuild and restart:
   ```
   docker compose -f compose.yaml -f deploy/container/compose.oci.yaml build songbook
   docker compose -f compose.yaml -f deploy/container/compose.oci.yaml up -d songbook
   ```
4. Verify `curl http://127.0.0.1:3010/healthz` and
   `curl https://okdam.lost.plus/healthz` return `{"ok":true}`.

## Cloudflare Workers (supported target)

`apps/worker` deploys the same application to Cloudflare Workers with D1 for
state and Workers Assets for the PWA. The Node-specific entry point
(`apps/server/src/main.ts`) is not used; the Worker entry point
(`apps/worker/src/index.ts`) binds D1 and proxies statics to Assets.

### One-time setup

```
cd apps/worker
npx wrangler d1 create okdam-songbook
# paste the printed database_id into wrangler.toml
npx wrangler d1 execute okdam-songbook --file=migrations/0001_init.sql
npx wrangler secret put AI_API_TOKEN   # optional, for AI readings
```

### Deploy

```
npm run build                 # repo root: builds shared/server-core/server/web
cd apps/worker
npx wrangler deploy
```

### Cutover from OCI

1. Take a SQLite backup on OCI (`deploy/ops/README.md`).
2. Apply the D1 schema and import data with `@songbook/admin` import tools
   or `sqlite3 .dump` piped through `wrangler d1 execute`.
3. Point `okdam.lost.plus` DNS/Tunnel at the Worker, then verify
   `curl https://okdam.lost.plus/healthz`.

### Known tradeoffs

- **Transactions**: D1 has no interactive transactions — you cannot hold one
  open while application code reads a result and decides what to write next,
  which is what every songbook mutation does. Statements therefore run
  immediately on Workers and `sqlite.transaction()` is a pass-through, so a
  mutation that fails partway leaves its earlier writes applied (a song
  without its audit row). Retries stay safe: claiming an idempotency key is a
  single INSERT OR IGNORE against the primary key. The Node/OCI runtime keeps
  real transactions with savepoints.
  `packages/server-core/test/d1-service.test.ts` drives the service through
  the D1 binding shape so this path is covered by `npm run verify`.
- **Do not enable D1 read replication.** It is off by default, which is what
  keeps every query on the primary and lets a mutation read back the row it
  just wrote. Turning it on in the dashboard routes reads to replicas that may
  lag behind the write, which breaks that assumption silently — mutations
  would start failing to find rows they had just inserted. Adopting it would
  mean threading D1's Sessions API and its bookmarks through every request
  first.
- **TJ mirror concurrency**: the in-memory in-flight dedup from the Node
  server does not exist on Workers, so concurrent stale searches for the same
  query may each fetch TJ once. Accepted behavior.
- **Backups**: use `wrangler d1 export` or the D1 time-travel/console
  snapshot instead of the OCI `.backup` script.
- **Static assets**: served by Workers Assets, not the filesystem.
