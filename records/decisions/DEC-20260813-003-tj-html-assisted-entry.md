# DEC-20260813-003: Bounded TJ HTML-Assisted Song Entry

Opened: 2026-08-13 13-21-00 KST
Recorded by agent: luna-docs

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: RSH-20260813-001, LOG-20260813-125942-lunatj, LOG-20260813-131305-grator

## Decision

Use a bounded, authenticated Apps Script adapter to fetch TJ Media's public
server-rendered accompaniment-search HTML from the fixed
`https://www.tjmedia.com/song/accompaniment_search` host and path. Parse only
the needed result rows into typed candidates; raw HTML never reaches the
browser. The adapter enforces query, page, result-size, cache, and throttle
bounds and returns structured upstream/parser errors.

The first user flow is exact TJ-number lookup, followed by bounded Unicode
search. An authenticated editor can add a selected candidate immediately with
one action. The server records `sourceType=tjmedia`, keeps the source URL, uses
`clientRequestId` replay safety, checks TJ-number and normalized title/artist
duplicates, and never overwrites an existing song. A deleted match is surfaced
for an owner-only restore path. Manual add and editing remain available when TJ
is unavailable or its markup drifts.

The source implementation is complete locally but the updated Apps Script has
not yet been pushed, deployed, or live-smoked.

## Context

TJ exposes the needed results as public HTML rather than a browser-safe API.
Direct browser fetches and embedding do not fit the GitHub Pages boundary. The
existing Apps Script endpoint already owns authenticated write operations,
server-side validation, and Sheet audit history.

## Options Considered

### Fetch or embed TJ directly from GitHub Pages

- Upside: less backend code.
- Downside: CORS/frame restrictions, raw markup in the client, and no stable
  server-side throttle or parser error boundary.

### Parse TJ HTML in Apps Script with bounded requests

- Upside: fixed-host control, existing allowlist/permission checks, short cache,
  and a typed browser contract.
- Downside: public markup can change and requires a deployed smoke check.

### Stop at manual entry

- Upside: no upstream dependency.
- Downside: keeps the highest-friction part of song entry entirely manual.

## Rationale

The Apps Script boundary is the smallest implementation that keeps TJ markup
and request controls off the browser while reusing the existing Sheet authority.
Manual entry remains a complete fallback, so an upstream outage does not block
the catalog or ordinary song management.

## Consequences

- Deployment must verify exact lookup, broad Unicode search, no-result,
  upstream-failure, throttle, and parser-drift outcomes.
- TJ data remains an editable candidate until an authenticated write succeeds.
- Parser maintenance belongs with the Apps Script adapter and shared candidate
  contract, not with page components.
