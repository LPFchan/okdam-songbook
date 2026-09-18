# Deployment

Songbook runs on Cloudflare Workers. There is one production shape
(DEC-20260919-001): the `okdam-songbook` Worker, D1 `okdam-songbook`, and
Workers Assets, behind the `auth-gateway` Worker.

## Topology

| piece | value |
| --- | --- |
| Worker | `okdam-songbook`, `apps/worker`, `workers_dev = false`, no `[[routes]]` |
| Zone route | `okdam.lost.plus/*` → `auth-gateway` (held in `LPFchan/auth`, `gateway/wrangler.toml`) |
| Path in | `auth-gateway` service binding `SONGBOOK_BACKEND` → `okdam-songbook` |
| Database | D1 `okdam-songbook`, APAC, id in `apps/worker/wrangler.toml`; schema `apps/worker/migrations/` |
| Static files | Workers Assets from `apps/web/dist`, `run_worker_first = true` |
| Secrets | `CLOUDFLARE_AI_API_TOKEN` (optional; with `AI_ENDPOINT` and `AI_MODEL` from `[vars]`, all three or none) |
| Compatibility | `compatibility_date = 2026-09-18`; Node.js built-ins are on by default at this date, no flag |

### Why the Worker has no route

Songbook trusts the gateway's `x-lost-plus-*` identity headers and cannot
tell a forged one from a real one (DEC-20260914-002). On Workers the
equivalent of a loopback bind is having no public route: `workers_dev =
false` and no `[[routes]]`, which leaves the gateway's service binding as the
only way in. **Deploying a Worker replaces its route list with what its
config says**, so never add a route here; the gateway owns it.

`/` and `GET /api/catalog` are public by gateway policy and arrive with no
identity headers, so the application cannot fail closed on missing identity
for every path — route-lessness is the guarantee, not a header check.

### Gateway routes for this host

Owned by `auth/gateway/config/cloudflare.gateway.json`; reproduced so the
behaviour is understandable from this repo. Longest prefix wins; a method
mismatch falls through to the next route rather than answering 405.

```json
{ "host": "okdam.lost.plus", "path_prefix": "/mcp", "policy": "mcp", "visibility": "okdam", "token_scope": "okdam-mcp", "binding": "SONGBOOK_BACKEND" },
{ "host": "okdam.lost.plus", "path_prefix": "/api/catalog", "methods": ["GET", "HEAD"], "policy": "public", "binding": "SONGBOOK_BACKEND" },
{ "host": "okdam.lost.plus", "path_prefix": "/api", "policy": "oauth", "visibility": "okdam", "binding": "SONGBOOK_BACKEND" },
{ "host": "okdam.lost.plus", "path_prefix": "/_auth/logout", "policy": "oauth", "visibility": "okdam", "binding": "SONGBOOK_BACKEND" },
{ "host": "okdam.lost.plus", "path_prefix": "/", "policy": "public", "binding": "SONGBOOK_BACKEND" }
```

- `GET /_auth/logout` is answered by the gateway; the application never
  sees it.
- `/healthz` matches the public `/` route, so the gateway forwards it and the
  application answers `{"ok":true}`.
- `/.well-known/oauth-protected-resource/mcp` is answered by the gateway.

## Deploy

```
npm run build                 # repo root: shared, server-core, mcp, admin, server, web
cd apps/worker
npx wrangler deploy           # expect "No targets deployed": the Worker is route-less
```

Credentials: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the
environment, or `wrangler login`. Secrets are set once with
`npx wrangler secret put CLOUDFLARE_AI_API_TOKEN` and survive deploys.

### Verify after every deploy

From anywhere on the internet, with `$TOKEN` an `okdam-mcp` machine token
(never echo it):

```
H=https://okdam.lost.plus
curl -s -o /dev/null -w '%{http_code}\n' $H/healthz                           # 200
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' $H/admin             # 200 text/html
curl -s -D - -o /dev/null $H/ | grep -i x-frame-options                       # DENY
curl -s -o /dev/null -w '%{http_code}\n' $H/api/catalog                       # 200
curl -s -o /dev/null -w '%{http_code}\n' $H/api/me                            # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: text/html' $H/api/me     # 302
curl -s -o /dev/null -w '%{http_code}\n' -X POST $H/mcp \
  -H 'Authorization: Bearer bogus' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}'   # 401
curl -s -X POST $H/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'
  # result.tools has eight names, result.ttlMs 300000, result.cacheScope "private"
```

2025-era clients (`protocolVersion` 2025-03-26 / 2025-06-18) get an SSE-framed
response; both must still initialize.

## Rollback

- **Code and assets**: `npx wrangler deployments list` then
  `npx wrangler rollback <version-id>` (or plain `wrangler rollback` for the
  previous version). Seconds, no data involved.
- **Data**: D1 Time Travel keeps 30 days of history.
  `npx wrangler d1 time-travel info okdam-songbook` shows the current
  bookmark; `npx wrangler d1 time-travel restore okdam-songbook
  --timestamp=<ISO>` restores. Export first with
  `npx wrangler d1 export okdam-songbook --remote --output=backup.sql`.
- **Schema**: migrations are append-only files under
  `apps/worker/migrations/`, applied with `npx wrangler d1 migrations apply
  okdam-songbook --remote` and recorded in D1's `d1_migrations` table. Rolling
  code back across a migration needs a Time Travel restore first.
- There is no container to fall back to. The OCI SQLite at
  `/var/lib/songbook/songbook.sqlite` is an archive of the catalogue at
  cutover (last write 2026-08-26) and predates every Workers write.

## State and backups

- D1 holds everything: songs, performances, private favorites, audit events,
  idempotency keys (24-hour), and the TJ mirror. No KV, no R2.
- Backups: `wrangler d1 export` on demand, plus Time Travel. Nothing is
  scheduled; the catalogue changes a few rows a week.
- Do not enable D1 read replication. Mutations read back the row they just
  wrote; replicas may lag.

## Known tradeoffs of the D1 runtime

- **No interactive transactions.** Statements run immediately and
  `sqlite.transaction()` is a pass-through, so a mutation that fails partway
  leaves earlier writes applied (a song without its audit row). Retries stay
  safe: the idempotency claim is a single `INSERT OR IGNORE` on the primary
  key, and a claim whose work threw is released so the retry reruns.
  `packages/server-core/test/d1-service.test.ts` covers this path.
- **Per-isolate memory.** The app is built once per isolate. The MCP body
  gate (4 in flight) and the TJ throttle (4 per 10 s) hold within an isolate
  and not across them; concurrent stale TJ searches in different isolates may
  each fetch once.
- **Bundle contents.** `packages/server-core` still exports the Node
  `openDatabase` (better-sqlite3 + drizzle, ~86 KiB) for tests and the admin
  tools; it is bundled and never called on Workers.

## Local development

```
npm run build          # once, at the repo root
cd apps/worker
npx wrangler dev       # http://localhost:8787 with a local D1
```

`wrangler dev` runs without the gateway, so protected routes see no identity
and answer 401. To exercise them locally, send the five `x-lost-plus-*`
headers by hand (see `apps/worker/test/index.test.ts` for the exact set).
