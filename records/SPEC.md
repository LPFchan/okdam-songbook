# Songbook Spec

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

- Project: Songbook
- Project id: `songbook`
- Canonical repo: https://github.com/devuterian/okdam-songbook
- Operator: Marie
- Last updated: 2026-09-14
- Related decisions: DEC-20260701-001 through DEC-20260701-008,
  DEC-20260813-001 through DEC-20260813-005, DEC-20260820-001 through
  DEC-20260820-003, DEC-20260821-001, DEC-20260914-001,
  DEC-20260914-002

## Project Thesis

Songbook is a mobile-first karaoke favorite-song manager. It helps a small
trusted group quickly search TJ karaoke numbers, titles, artists, Korean
readings for Japanese songs, recommended keys, notes, and recent singing
history.

## Runtime Shape

- One Cloudflare Worker (`okdam-songbook`) serves the PWA from Workers
  Assets, the same-origin API, TJ integration, health endpoint, and MCP
  endpoint through one Hono application. The Common Auth `auth-gateway`
  Worker holds the `okdam.lost.plus/*` route, validates identity, and reaches
  the application only over a service binding.
- The Worker declares no route of its own and validates no credential; it
  trusts the gateway's injected `x-lost-plus-*` identity headers only.
- D1 is the operational database for songs, private per-account favorites,
  performers, performances, audit events, idempotency records, and the
  search-driven TJ mirror.
- The catalog is the primary surface for search, filters, account/session
  state, theme, sync status, and role-aware management entry points.
- The main search is an omnibar: saved-song matches appear immediately, then
  authenticated debounced TJ matches continue below with inline add actions.
  The MCP `search_songs` tool uses the same trimmed-length gate (at least two
  characters or all digits) and numeric queries select number search.
- Manage and history tools open contextually from the catalog toolbar; manual
  add remains a TJ-search fallback. `/admin` is a compatibility alias to the
  same composition, not a separate security boundary.

## Core Capabilities

- Dense mobile song list with TJ number priority and no album art.
- Search by TJ number, title, artist, Korean reading, country, memo, and
  assigned performer.
- Authenticated users may generate editable Korean-reading candidates for a
  song title and artist; generated values are never saved automatically.
- Quick filter chips plus a complete responsive filter surface; sort remains
  separate.
- Favorites belong to the signed-in account's immutable Common Auth subject,
  not its mutable email and not to the song. The heart toggles
  that private relationship directly, and the favorite-only filter requires a
  valid session. Favorite state is never included in the anonymous catalog.
- Song add/edit uses one country chip: `일본`, `미국`, `한국`, or `그 외`.
- Songs keep one optional recommended key (`original`, `male`, or `female`
  plus a semitone offset). Free-form context such as an original work belongs
  in the memo instead of separate metadata fields.
- Bottom-sheet song details with performance history and `오늘 불렀습니다!`.
  Each tap records the signed-in account as the singer. The latest record shows
  that account's configured public name when it is known, while joint singing
  is represented by one record from each person's account.
- Offline-first public read cache and queued performance writes. Queue rows are
  owned by the immutable Common Auth subject; replay refreshes the browser
  session and the server rejects an owner-subject mismatch before writing.
  Pre-subject queue rows are quarantined instead of assigned by email.
- Local-first omnibar search, bounded debounced TJ accompaniment search, and
  authenticated one-action candidate add with country inferred from existing
  artist matches and the title/artist writing systems, plus manual fallback.
- Server-authoritative duplicate checks, replay-safe writes, TJ provenance, and
  hard deletion by allowed users.
- Browser sessions use the shared HTTP-only `lp_auth` cookie scoped to
  `.lost.plus`. The gateway admits identities whose service list is empty or
  contains `okdam`, removes the cookie, and supplies verified identity headers.
- Every centrally admitted account has the same `allowed` role and permissions,
  including song deletion. Common-auth rejection, malformed identity, or
  unavailability fails closed.
- Stateless MCP Streamable HTTP is a required-bearer mount at `/mcp`, with
  modern and legacy stateless compatibility, centralized Common Auth OAuth or
  machine-token validation, per-tool capabilities, and no long-lived MCP
  session state. Every request without verified gateway identity fails before
  MCP dispatch.
- MCP requires `songbook:read` for `catalog`, combined `search_songs`, and
  `get_song`; every mutation tool requires `songbook:write`. Every admitted
  Common Auth credential receives both internal capabilities,
  and protected operations use the same domain services and validation as the
  browser API.
- Songs store structured `performerIds` for who will sing the song. Built-in
  performers are `marie`, `seongwook`, and `yeowool`; legacy `뽀냐` input maps to
  `marie` plus `yeowool` and is not a stored user ID. New-song entry preselects
  the signed-in person's matching performer, including one-tap TJ adds; the
  manual form remains editable before saving.

## Invariants

- D1 `okdam-songbook` is the operational source of truth. The OCI SQLite,
  Google Sheets and repo JSON are archives or recovery exports, not live
  production stores.
- Secrets, allowed emails, OAuth credentials, database files, and backup
  archives are never bundled in the frontend or committed to the repository.
- Browser- or MCP-supplied identity values are never authority. The gateway
  removes them and the server uses only gateway-injected account ID, email,
  public name, and role.
- Private ownership and idempotency use the immutable Common Auth `sub` with
  an `auth.lost.plus:` namespace. Stored email/name fields are historical
  attribution snapshots only.
- Browser private-state reads and durable writes carry their expected immutable
  subject. The server requires and compares that subject with the current
  gateway identity. Editable drafts and asynchronous AI/TJ work stay bound to
  the account that started them; the browser discards results and clears draft
  state after an account switch.
- Public catalog rows may expose the configured public name of the account that
  created the latest active performance. They never expose its email address;
  an unmapped historical email falls back to timestamp-only display.
- Shared browser sessions use HTTP-only cookies, but cookies never grant MCP
  identity. The MCP gateway requires either a resource-bound OAuth access token
  or a valid `okdam-mcp` machine credential on every request and rejects
  malformed, expired, revoked, or incorrectly scoped credentials before the
  request reaches Songbook. The private Songbook server independently rejects
  every MCP request without gateway-injected identity.
- MCP request bodies have a fixed byte ceiling, an absolute read timeout, and
  a small shared concurrency gate held until both the response and invoked tool
  work finish. Client cancellation does not release that gate while backend
  work continues. Declared and chunked oversized bodies are rejected before
  JSON admission can retain unbounded memory in the shared browser/API/MCP
  process.
- Browser mutations require JSON and the exact configured origin. Public
  catalog reads remain available without login.
- Every HTML shell and SPA fallback denies framing, so another origin cannot
  clickjack authenticated controls whose same-origin API calls would otherwise
  be valid.
- Every write carries an idempotency key. Offline replay and MCP retries must
  preserve it across process restarts and lost responses.
- TJ candidates remain editable, attributed input until an authenticated
  D1 write succeeds. TJ outages or parser drift never remove manual entry
  or public catalog access.
- The TJ mirror stores normalized songs plus exact query/page memberships in
  D1. Each canonical query is fresh for 24 hours; stale refreshes wait for
  TJ, retain the prior snapshot on failure, and emit operational failure
  metadata. Search is the only ingestion path and mirrored songs are retained.
- Backups are useful only when integrity checks and a restore drill pass.
- `noindex` and link obscurity reduce discoverability only; they are not access
  control.
