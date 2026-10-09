# DEC-20261009-001: DAM Mode With Live clubdam.com Lookup

Opened: 2026-10-09 16-40-00 KST
Recorded by agent: claude

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260820-001, DEC-20260813-004

## Decision

Songbook supports DAM (Japanese karaoke) alongside TJ. Each song carries an
optional `dam_number` ("1472-59", unique across songs). A TJ/DAM chip in the
topbar switches the catalog per device; DAM mode shows and sorts by DAM
numbers, hides songs without one, and continues the omnibar into DAM search.

DAM is searched live through clubdam.com's JSON search API, behind a
per-isolate cache (one day) and throttle. Unlike TJ (DEC-20260820-001), there
is no D1 mirror. Adding a DAM candidate links its number to a saved song with
the same title and artist when that song has no DAM number; otherwise it
creates a new song with `clubdam` provenance.

## Context

The group sings in Japan as well as Korea, and most saved songs are Japanese.
TJ and DAM number the same songs differently, so a song needs both numbers,
not two copies. DAM exposes a JSON API with a public client key, so there is
no HTML parsing to protect against.

## Options Considered

### Mirror DAM in D1 like TJ

- Upside: searches survive DAM outages
- Downside: another table, refresh policy and failure metadata for a lookup
  the group uses occasionally

### Live lookup with an in-memory cache

- Upside: no schema beyond one column; DAM outages only hide DAM candidates
- Downside: the cache is per isolate, so cold isolates hit DAM again

### Separate song rows per karaoke system

- Rejected: performances, favorites and keys belong to the song, not to a
  system's catalogue entry

## Rationale

Live lookup is the smallest thing that gives TJ parity in the UI. A mirror
can be added later if DAM throttling or outages become a real problem.

## Consequences

- Migration `0002_dam_number.sql` adds the column and a unique index.
- Existing songs are backfilled with `scripts/dam-match.mjs`, which only
  suggests matches; a human reviews them before they are applied.
- The MCP tools accept and return `damNumber`, and `search_songs` can include
  DAM candidates with `includeDam`.
