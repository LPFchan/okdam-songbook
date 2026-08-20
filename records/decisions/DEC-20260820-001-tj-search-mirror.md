# DEC-20260820-001: Persist a Search-Driven TJ Mirror

Opened: 2026-08-20 17-42-30 KST
Recorded by agent: codex-tj-mirror

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: DEC-20260813-003

## Decision

Persist normalized TJ songs, exact canonical search-query snapshots, and
query-to-song membership in the existing SQLite database. Each exact query
key (including search type, nation, page, and page size) is fresh for 24 hours;
the first stale request waits for a live refresh. Search is the only ingestion
path, pages 1–10 are independent, and mirrored songs remain indefinitely.

Refresh failures keep serving the older snapshot when one exists, while
recording attempt/error/failure metadata and emitting an operational warning.
The first failure without a snapshot keeps the existing manual-fallback error.
Candidate provenance is reconstructed from the serving query URL.

## Context

The live Node server previously kept successful TJ responses in a 30-second
in-memory map. That lost observed songs on restart and did not provide an
operational record when a stale refresh or parser drift failed. SQLite is
already the persistent, backed-up store shared by the single server.

## Options Considered

### Keep the Short-Lived In-Memory Response Cache

- Upside: no schema or persistence work
- Downside: no growing local TJ index, no restart survival, and weak failure visibility

### Add a Scheduled or Crawling TJ Ingestion Job

- Upside: broader coverage without user searches
- Downside: unnecessary upstream load and a second ingestion workflow outside the accepted search-driven product boundary

### Add a Search-Driven SQLite Mirror

- Upside: preserves exact query freshness, grows from real use, survives restart, and can serve stale snapshots during outages
- Downside: pages can have different ages until a future combined-paging surface defines seam behavior

## Rationale

The SQLite mirror matches the accepted local TJ index destination and the
existing single-process database boundary. Normalized song rows avoid storing
duplicate copies of a song while query membership preserves exact result order
and query provenance. Per-page freshness keeps the refresh rule explicit and
bounded without inferring deletion from partial pages.

## Consequences

- The mirror grows only as users search; it has no expiry, cap, or crawler.
- Query refresh metadata makes parser and upstream failures visible without
  taking an older snapshot away from callers.
- Future combined pagination must account for independently aged page rows and
  must not imply that a missing row means TJ deleted a song.
