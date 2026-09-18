# Songbook Plans

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Accepted Directions

### Unified catalog-first surface

- Status: `live in production`.
- Main catalog owns account, filters, theme, sync, and the local-first search
  omnibar. TJ candidates follow saved matches after a 450 ms debounce and can
  be added inline. Manage/history remain contextual toolbar utilities.
- `/admin` remains a compatibility alias rather than a separate composition.
- Related ids: DEC-20260813-002, DEC-20260813-004.

### TJ-assisted discovery and entry

- Status: `live in production; deeper live smoke pending`.
- Exact lookup, bounded Unicode search, editable autofill, immediate add,
  duplicate outcomes, provenance, replay safety, and deleted-row restore are
  implemented behind authenticated same-origin actions.
- Manual entry remains the fallback for no-result, upstream, throttle, and
  parser-drift outcomes.
- Related ids: DEC-20260813-003.

### Cloudflare Workers architecture

- Status: `live in production at okdam.lost.plus` since 2026-09-18; the OCI
  container shape is retired (DEC-20260919-001).
- One Worker serves the PWA (Workers Assets), API, D1 state, TJ integration,
  health checks, and stateless MCP. `auth.lost.plus` owns identity, sessions,
  bearer tokens, service admission, and revocation.
- The cloud Common Auth gateway revalidates browser and MCP credentials on
  every protected request, then supplies verified identity to the route-less
  Worker over a service binding. Every admitted account has the same
  `allowed` role and mutation permissions.
- Related ids: DEC-20260813-001, DEC-20260813-005, DEC-20260814-001,
  DEC-20260914-001, DEC-20260914-002, DEC-20260918-001, DEC-20260919-001.

### Anonymous MCP and common-auth-protected operations

- Status: `live in production at okdam.lost.plus` (`4d98aa5`, packaging fix
  `d812381`).
- Stateless MCP exposes public catalog, combined saved/TJ search, and active
  song lookup without a bearer. Every mutation uses `songbook:write`.
- Body-derived routing rejects malformed credentials and prevents anonymous
  access to protected, unknown, ambiguous, or batch requests. Browser cookies
  never grant MCP identity.
- Shared bearers are minted and revoked at `auth.lost.plus` under the
  `okdam-mcp` token scope; every admitted identity receives Songbook's
  read/write capabilities.
- Related ids: DEC-20260820-002, DEC-20260820-003, DEC-20260914-001,
  DEC-20260914-002.

## OCI Rollout Sequence (Completed 2026-08-13/14; shape retired 2026-09-18, see DEC-20260919-001)

1. ~~Native OCI ARM64 image build, start, database health, disk-space gate.~~
   Done — image `songbook:local` (ARM64) healthy on oci-ubuntu.
2. ~~Final origin, Google callback, Better Auth secret, and email allowlist.~~
   Done — configured via host-only `deploy/container/songbook.env`.
3. ~~Sheet snapshot import and reconciliation into SQLite.~~ Done — production
   `/var/lib/songbook/songbook.sqlite` imported and serving.
4. ~~Scheduled backup, integrity checks, retention, guarded restore.~~ Done —
   `songbook-backup.timer` runs daily; restore drill completed 2026-08-13.
5. Shared bearer MCP matrix (valid token, `okdam` admission, revocation,
   stateless modern/legacy, restart). **Open.**
6. Browser authentication, anonymous reads, protected writes, TJ flows,
   offline replay, multiple tabs, service-worker cache through
   okdam.lost.plus. **Partially verified in daily use; systematic smoke
   pending.**
7. ~~One-time GitHub Pages cleanup/redirect release; disable automatic Pages
   deploys.~~ Done — Pages workflow is a manual-dispatch redirect stub.
8. ~~Cloudflare Tunnel/DNS switch to OCI with operator authorization.~~ Done —
   `okdam.lost.plus` routes through the `obsidian-sync` tunnel to
   `localhost:3010`.

## Deferred Work

- Korean-reading generation is live through Cloudflare Workers AI with
  `@cf/google/gemma-4-26b-a4b-it`. YouTube metadata and image/song extraction
  remain deferred.
- Cross-tab offline queue claiming remains deferred until the queue has durable
  lease-owner and lease-expiry fields with an atomic claim transaction.
- TJ add response replay should move duplicate detection behind the same
  idempotency record so repeated client request IDs return the original outcome.
- TJ parser maintenance and upstream compatibility review follow the fixed-host
  contract and parser-drift tests.
- Systematic shared-bearer MCP client verification (item 5 above).
- Delete or port the legacy Apps Script/Sheets source, the ChatGPT proxy,
  and the Node-only SQLite admin tools (`packages/songbook-admin`,
  `scripts/import-csv.mjs`), none of which can target D1.
- Split the Node-only `openDatabase` out of `packages/server-core`'s main
  export so the Worker bundle stops carrying better-sqlite3 and drizzle.
- Archive and remove the OCI leftovers listed in `records/STATUS.md`.

## Verification Ownership

- Data owner: accept D1 exports, Time Travel restores, and any future
  migration under `apps/worker/migrations/`.
- Auth/MCP owner: verify exact origins/cookies, shared session lifecycle,
  service admission, bearer revocation, and stateless tools.
- Integration owner: verify browser/TJ/offline behavior on real devices and
  keep the deploy procedure in `records/STATUS.md` accurate.
