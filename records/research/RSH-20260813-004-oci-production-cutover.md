# RSH-20260813-004: OCI Production Cutover

Opened: 2026-08-13 22-00-00 KST
Recorded by agent: codex-orchestrator

## Outcome

`https://okdam.lost.plus` was cut over to the OCI single-server application on
2026-08-13 KST. Cloudflare proxies the hostname to the existing OCI tunnel,
whose first ingress rule sends it to `http://localhost:3010`. Existing tunnel
routes were preserved.

The deployed source baseline is `7f231e7`. The OCI checkout is
`/home/ubuntu/okdam-songbook`, the image is `songbook:7f231e7-arm64`, and the
Compose project is `songbook`. The container publishes only
`127.0.0.1:3010`, runs as UID/GID 1000, uses a read-only root filesystem, and
stores its database at `/var/lib/songbook/songbook.sqlite`.

## Verified Evidence

- Native OCI build produced an `arm64` Linux image with the non-root `node`
  runtime user and `apps/server/dist/main.js` command.
- The container reached healthy state and public `/healthz` returned 200.
- Public `/api/catalog` returned 118 active songs and supports ETag/304 reads.
- Public MCP protected-resource and authorization-server metadata use
  `https://okdam.lost.plus` and advertise read, write, and admin scopes.
- Unauthenticated MCP requests receive 401 and a bearer resource-metadata
  challenge. Unauthenticated `/api/me` receives 401.
- Existing `mcp`, `marble`, `joongna`, `tweet`, `vault`, and `thinq` tunnel
  hostnames retained their expected redirect or authentication responses after
  the cloudflared restart.
- A checksum-backed online SQLite backup passed integrity validation. A restore
  drill to a separate file passed integrity validation and contained 118 songs.
- `songbook-backup.timer` is enabled on OCI. Its first scheduled-path run and
  the freshness checker succeeded; local retention is 30 days.

## Data Boundary

The live anonymous Apps Script `publicData` response was captured and imported
as a catalog-only snapshot. The importer dry-run accepted 118 songs with no
warnings or errors; the first pass inserted 118, the second pass reported 118
unchanged, reconciliation had zero differences, and a recovery CSV was
generated.

The public response contains no performance or ChangeLog rows. The production
SQLite database therefore has the complete publicly visible catalog but does
not yet claim complete private history. A Sheet-authorized export of `Songs`,
`Performances`, and `ChangeLog` remains required before the legacy data source
can be retired.

## Remaining External Gates

- Vaultwarden supplied a confidential Google OAuth client and the server now
  emits a correct PKCE authorization request for
  `https://okdam.lost.plus/api/auth/callback/google`. Google currently returns
  `redirect_uri_mismatch`; that callback must be registered on the client
  before browser login and writes can be accepted as production-ready.
- A real external MCP client OAuth flow cannot complete until browser login is
  available. Discovery, resource binding, scopes, stateless transport, and
  local protocol tests are otherwise in place.
- The legacy Pages site is owned by `devuterian/okdam-songbook`; the current
  GitHub identity has read-only access. The cleanup artifact is committed in
  `apps/pages-retirement`, but deployment to the old origin requires an owner
  of that repository. The corresponding workflow run in the LPFchan repository
  correctly failed because Pages is not enabled there.
- The pruned production dependency graph reported 10 audit findings during the
  ARM64 image build (7 moderate, 3 high). Review and deliberate dependency
  upgrades are required; no automatic force upgrade was applied during
  cutover.

## Rollback

The prior wildcard-derived DNS behavior was superseded by one exact proxied
`okdam.lost.plus` CNAME. Rollback can remove that exact record and the first
cloudflared ingress rule without touching other tunnel routes. The staged
SQLite backup and prior external data source are retained.
