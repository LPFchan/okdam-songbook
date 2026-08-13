# Songbook Spec

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

- Project: Songbook
- Project id: `songbook`
- Canonical repo: https://github.com/devuterian/okdam-songbook
- Operator: Marie
- Last updated: 2026-08-13
- Related decisions: DEC-20260701-001 through DEC-20260701-008, DEC-20260813-001 through DEC-20260813-003

## Project Thesis

Songbook is a mobile-first karaoke favorite-song manager. It helps a small
trusted group quickly search TJ karaoke numbers, titles, artists, Korean
readings for Japanese songs, recommended keys, notes, and recent singing
history.

## Main Surface

- Public GitHub Pages PWA under `/okdam-songbook/`.
- The catalog is the primary surface for search, filters, account/session
  state, theme, sync status, and role-aware management entry points.
- Add, manage, and history tools open contextually from the main surface.
- `/okdam-songbook/admin/` remains a compatibility deep link to the same
  composition; it is not a separate security boundary.
- Google Apps Script Web App API backed by a private Google Sheets workbook
  with `Songs`, `Performances`, and `ChangeLog` sheets.
- Existing Cloudflare Worker integration at `/authorize`, `/token`, and
  `/api/gpt*` for ChatGPT Actions.

## Core Capabilities

- Dense mobile song list with TJ number priority and no album art.
- Search by TJ number, title, artist, aliases, Korean reading, romanization,
  genre, country, original work, memo, and assigned performer.
- Quick filter chips plus a complete responsive filter surface; sort remains
  separate.
- Bottom-sheet song details with performance history and
  `오늘 불렀습니다!`.
- Offline-first public read cache and queued performance writes.
- Exact TJ-number lookup, bounded TJ accompaniment search, editable candidate
  autofill, and authenticated one-action candidate add with manual fallback.
- Server-authoritative duplicate checks, replay-safe writes, TJ provenance, and
  owner-only restore for deleted matches.
- Better Auth browser-session foundation on the Cloudflare Worker: Google
  OAuth, D1 data, renewable HTTP-only sessions, current-user admission, and a
  protected Worker-to-Apps-Script browser gateway. The source path is
  feature-disabled until production provisioning is complete.
- GIS direct-token transport remains available as an explicit rollback path
  during the auth migration.
- Owner/editor role matrix enforced by Apps Script, including song CRUD,
  deletion/restore, performance history, ChangeLog, and AI helper adapters.
- Songs store structured `performerIds` for who will sing the song. Built-in
  performers are `marie`, `seongwook`, and `yeowool`; legacy `뽀냐` input maps to
  `marie` plus `yeowool` and is not a stored user ID.

## Invariants

- The Google Sheet is the operational source of truth.
- GitHub repo JSON is not the production data store.
- Secrets, allowed emails, OAuth secrets, D1 ids, and internal proxy secrets
  are never bundled in the frontend or committed to the repository.
- Browser-supplied email, actor, or role values are never authority for
  writes. Apps Script resolves the current allowlist and role.
- Better Auth sessions use HTTP-only cookies; Google ID tokens are not persisted
  in browser-readable storage, URLs, IndexedDB, or service-worker caches.
- Public reads remain available without login. Protected writes require a
  valid session transport and server-side permission checks.
- TJ candidates remain editable, attributed input until an authenticated Sheet
  write succeeds. TJ outages or parser drift never remove manual entry or
  public catalog access.
- `noindex` and link obscurity reduce discoverability only; they are not access
  control.
- ChatGPT Action OAuth remains a separate protocol from browser sessions.
