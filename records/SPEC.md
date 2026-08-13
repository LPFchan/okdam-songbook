# Songbook Spec

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

- Project: Songbook
- Project id: `songbook`
- Canonical repo: https://github.com/devuterian/okdam-songbook
- Operator: Marie
- Last updated: 2026-08-13
- Related decisions: DEC-20260701-001 through DEC-20260701-008, DEC-20260813-001 through DEC-20260813-005

## Project Thesis

Songbook is a mobile-first karaoke favorite-song manager. It helps a small
trusted group quickly search TJ karaoke numbers, titles, artists, Korean
readings for Japanese songs, recommended keys, notes, and recent singing
history.

## Runtime Shape

- One Node 22/Hono application runs on OCI and serves the PWA, same-origin API,
  Better Auth routes, TJ integration, health endpoint, and MCP endpoint.
- Cloudflare Tunnel may provide ingress to the OCI service, but no application
  logic runs in a Cloudflare Worker.
- SQLite is the operational database for songs, performers, performances,
  audit events, idempotency records, Better Auth state, and MCP token-resource
  bindings.
- The catalog is the primary surface for search, filters, account/session
  state, theme, sync status, and role-aware management entry points.
- The main search is an omnibar: saved-song matches appear immediately, then
  authenticated debounced TJ matches continue below with inline add actions.
- Manage and history tools open contextually from the catalog toolbar; manual
  add remains a TJ-search fallback. `/admin` is a compatibility alias to the
  same composition, not a separate security boundary.

## Core Capabilities

- Dense mobile song list with TJ number priority and no album art.
- Search by TJ number, title, artist, aliases, Korean reading, romanization,
  genre, country, original work, memo, and assigned performer.
- Quick filter chips plus a complete responsive filter surface; sort remains
  separate.
- Bottom-sheet song details with performance history and
  `오늘 불렀습니다!`.
- Offline-first public read cache and queued performance writes.
- Local-first omnibar search, bounded debounced TJ accompaniment search, and
  authenticated one-action candidate add with manual fallback.
- Server-authoritative duplicate checks, replay-safe writes, TJ provenance, and
  owner-only restore for deleted matches.
- Better Auth Google OAuth and renewable HTTP-only browser sessions use the
  same SQLite database as the songbook domain.
- The server resolves the current allowlist and owner/editor role on every
  protected request. Missing admission configuration fails closed.
- Stateless MCP Streamable HTTP is mounted at `/mcp`, with legacy stateless
  compatibility, bearer-only OAuth, resource binding, per-tool scopes, and no
  long-lived MCP session state.
- MCP exposes catalog, search, song lookup, performance recording, and
  performance cancellation through the same domain service as the browser API.
- Songs store structured `performerIds` for who will sing the song. Built-in
  performers are `marie`, `seongwook`, and `yeowool`; legacy `뽀냐` input maps to
  `marie` plus `yeowool` and is not a stored user ID.

## Invariants

- SQLite on OCI is the operational source of truth. Google Sheets and repo JSON
  are migration inputs or recovery exports, not live production stores.
- Secrets, allowed emails, OAuth credentials, database files, and backup
  archives are never bundled in the frontend or committed to the repository.
- Browser- or MCP-supplied identity and role values are never authority. The
  server derives identity from Better Auth and rechecks the current allowlist.
- Better Auth sessions use HTTP-only cookies. MCP accepts bearer credentials
  only and rejects cookie or mixed cookie/bearer authentication.
- Browser mutations require JSON and the exact configured origin. Public
  catalog reads remain available without login.
- Every write carries an idempotency key. Offline replay and MCP retries must
  preserve it across process restarts and lost responses.
- TJ candidates remain editable, attributed input until an authenticated
  SQLite write succeeds. TJ outages or parser drift never remove manual entry
  or public catalog access.
- Backups are useful only when integrity checks and a restore drill pass.
- `noindex` and link obscurity reduce discoverability only; they are not access
  control.
