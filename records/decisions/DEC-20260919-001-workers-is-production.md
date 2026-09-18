# DEC-20260919-001: Cloudflare Workers Is the Only Production Shape

Opened: 2026-09-19 04-40-00 KST
Recorded by agent: claude

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Supersedes: the "two interchangeable production topologies" framing of
  DEC-20260814-001 and the "cutover is blocked" state of DEC-20260918-001
- Related ids: DEC-20260914-002, DEC-20260918-001

## Decision

Songbook runs on Cloudflare Workers and nowhere else. The `okdam-songbook`
Worker, D1 `okdam-songbook`, and Workers Assets are production; the
`auth-gateway` Worker holds the `okdam.lost.plus/*` route and reaches the
application only over its `SONGBOOK_BACKEND` service binding. The OCI
container shape is retired: its packaging (Dockerfile, compose, deploy
scripts, systemd backup units, the Node entry point) is removed from the
repository, and the OCI SQLite file is an archive of the catalogue as it stood
at cutover, not a rollback target.

Rollback is a Worker version rollback plus, where data is involved, a D1 Time
Travel restore. There is no warm standby.

## Context

The cutover happened on 2026-09-18 (`07d542b`, `8449a2c`) once the cloud
gateway existed, which is what DEC-20260918-001 had been waiting for. The
data was migrated to D1 from the OCI SQLite and the container was torn down
the same day.

An audit on 2026-09-19 compared the Worker against the container it replaced
and found the runtime had regressed in ways the cutover checks did not cover:

- SPA deep links such as `/admin` returned 404. The shared Hono app registers
  a catch-all that answered 404 before the Worker's asset fallback could run.
- `/` and `/index.html` were served by Workers Assets before the Worker ran,
  so the `X-Frame-Options`/CSP frame-denial headers were missing.
- The app was rebuilt on every request, so the in-memory MCP body gate and TJ
  throttle limited nothing.
- With no transaction on D1, a mutation that threw left its idempotency claim
  behind, and every retry with the same `clientRequestId` — which is what the
  offline queue sends — was answered `CONFLICT` for a day.
- The MCP server advertised no cache hint for `tools/list`.
- D1 did not record that `0001_init.sql` had been applied.

Every row of `songs` and `performances` was verified identical between the
OCI SQLite and D1, so the migration itself was complete; only
`idempotency_keys` (24-hour rows, all expired) was not carried.

## Options Considered

### Keep the container packaging as a documented fallback

- Upside: a rebuild path exists on paper
- Downside: the SQLite it would serve predates every Workers write, so the
  fallback silently loses data
- Downside: every doc has to describe two shapes, and the audit found they
  had already drifted apart

### Remove the container shape and rely on Workers-native rollback

- Upside: one shape to describe, deploy, and test
- Upside: `wrangler rollback` and D1 Time Travel are faster than a rebuild and
  do not lose Workers-era writes
- Downside: depends on Cloudflare for both code and data recovery

### Rebuild the Worker as an all-authenticated service so it can fail closed

- Rejected: `/` and `GET /api/catalog` are public by design, so absent
  identity headers are a valid state; route-lessness is what keeps direct
  calls out (DEC-20260918-001).

## Rationale

The fallback the first option preserves is one nobody would use: it restores
a catalogue frozen at cutover. Removing it makes the docs true and the test
suite honest — the Worker entry now has its own suite driven through a fake
D1 and a fake Assets fetcher, which is where the regressions above would have
been caught.

## Consequences

- `apps/server` is the Hono application the Worker mounts, not a server. It
  keeps `node:fs` for the Node static path that nothing takes; Node.js
  compatibility is on by default at the Worker's compatibility date.
- `packages/server-core` still exports the better-sqlite3 `openDatabase`,
  used by tests and `packages/songbook-admin`. It is bundled into the Worker
  (about 86 KiB) and never called there. Splitting it out is a later cleanup.
- `packages/songbook-admin` and `scripts/import-csv.mjs` operate on a SQLite
  file and cannot target D1. They are kept as Node-only tools pending a
  decision to delete or port them.
- The OCI host keeps `/var/lib/songbook/songbook.sqlite`, the archives under
  `/var/backups/songbook`, and the `songbook-backup.timer`; all are
  archive-only and can be removed.
- `integrations/chatgpt-proxy` is not deployed in the operator's account and
  targets the retired Apps Script backend. It is unrelated to this shape.
