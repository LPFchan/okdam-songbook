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

### Prerequisite: the Worker must not be the edge

Songbook trusts the Common Auth gateway's `X-Lost-Plus-*` identity headers and
cannot tell a forged one from a real one (DEC-20260914-002). On OCI the Node
port is bound to loopback, so only the gateway can reach it. A Worker has no
loopback, so the equivalent guarantee is having no public route:
`wrangler.toml` sets `workers_dev = false` and declares no `[[routes]]`, which
leaves a service binding from the gateway Worker as the only way in.

**Adding a route or a workers.dev subdomain without the gateway in front is an
authentication bypass** — anyone setting four headers becomes any user. The
cutover is blocked until a gateway Worker is deployed and its service binding
to this Worker is configured (DEC-20260918-001).

The gateway rewrite exists in `LPFchan/auth` under `gateway/` and runs on
workerd, but no gateway Worker is deployed on Cloudflare yet. The other
Workers-hosted services each implement Common Auth themselves in the meantime.
Songbook does not copy that: DEC-20260914-002 removed its auth client on
purpose and DEC-20260918-002 rejects per-service validation, so this runtime
waits for the gateway instead.

### State so far

D1 database `okdam-songbook` is provisioned in APAC, its id is in
`wrangler.toml`, and `migrations/0001_init.sql` has been applied.

The Worker is deployed and carries no public route: `wrangler deploy` reports
`No targets deployed`, and `okdam-songbook.yeowool.workers.dev` answers 404
rather than reaching the application. It exists so a gateway Worker has a
service to bind to; nothing can call it until one does.

D1 holds a **dated snapshot** taken 2026-09-18 18:32 KST: 127 songs, 19
performances, 107 audit events, and the three `tj_mirror_*` tables, each
matching the OCI counts at that moment. It was imported to prove the path
works, not to serve traffic.

> **Re-import at cutover.** Every song added or edited on OCI after that
> timestamp is missing here, and nothing detects it — the Worker would come up
> looking healthy and quietly serving stale data. Clear the tables and import
> again as part of the cutover, not before it.

`idempotency_keys` is deliberately not imported: the rows expire after 24
hours and exist to deduplicate in-flight retries, so a stale copy has no value.
`schema_migrations` is also skipped because the D1 migration wrote its own.

Regenerate the dump with:

```
for t in songs performances song_favorites audit_events \
         tj_mirror_songs tj_mirror_queries tj_mirror_query_results; do
  sudo sqlite3 /var/lib/songbook/songbook.sqlite \
    ".mode insert \"$t\"" "SELECT * FROM \"$t\";" >> okdam-data.sql
done
npx wrangler d1 execute okdam-songbook --remote --file=okdam-data.sql
```

### Gateway routes for the cutover

The identity contract needs no change: the V8 gateway injects the same
`x-lost-plus-sub`, `-email`, `-name`, `-role`, and `x-lost-plus-encoding:
percent-utf8` that `apps/server/src/auth.ts` already reads.

What changes is how the gateway reaches the backend. Each route names a
`binding` instead of a loopback `upstream`, so on Cloudflare these five entries
replace the `okdam.lost.plus` block in `deploy/oci/gateway.json`. Order is
significant — the gateway takes the first matching prefix, so `/api/catalog`
has to precede `/api` or the public catalog becomes login-gated.

```json
{ "host": "okdam.lost.plus", "path_prefix": "/mcp", "policy": "mcp", "visibility": "okdam", "token_scope": "okdam-mcp", "binding": "SONGBOOK_BACKEND" },
{ "host": "okdam.lost.plus", "path_prefix": "/api/catalog", "methods": ["GET", "HEAD"], "policy": "public", "binding": "SONGBOOK_BACKEND" },
{ "host": "okdam.lost.plus", "path_prefix": "/api", "policy": "oauth", "visibility": "okdam", "binding": "SONGBOOK_BACKEND" },
{ "host": "okdam.lost.plus", "path_prefix": "/_auth/logout", "policy": "oauth", "visibility": "okdam", "binding": "SONGBOOK_BACKEND" },
{ "host": "okdam.lost.plus", "path_prefix": "/", "policy": "public", "binding": "SONGBOOK_BACKEND" }
```

`SONGBOOK_BACKEND` must also be declared as a service binding to the
`okdam-songbook` script in the gateway Worker's own `wrangler.toml`, and the
gateway takes the `okdam.lost.plus` route that the Tunnel holds today.

```
cd apps/worker
npx wrangler secret put AI_API_TOKEN   # optional, for AI readings
```

### Deploy

```
npm run build                 # repo root: builds shared/server-core/server/web
cd apps/worker
npx wrangler deploy
```

### Cutover from OCI

1. Stand up the cloud Common Auth gateway and bind it to this Worker as a
   service binding. Without it, stop here.
2. Take a SQLite backup on OCI (`deploy/ops/README.md`).
3. Import data with `@songbook/admin` import tools or `sqlite3 .dump` piped
   through `wrangler d1 execute --remote`. The seven Better Auth tables in the
   OCI database (`user`, `session`, `account`, `verification`, `oauth*`) are
   left over from before Common Auth and are not imported.
4. Point `okdam.lost.plus` DNS/Tunnel at the **gateway**, not at this Worker,
   then verify `curl https://okdam.lost.plus/healthz` and confirm that forged
   `X-Lost-Plus-*` headers on `/api/me` still return 401.

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
