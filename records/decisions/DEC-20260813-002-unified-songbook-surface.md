# DEC-20260813-002: Unified Songbook Main Surface

Opened: 2026-08-13 13-20-30 KST
Recorded by agent: luna-docs

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Supersedes: DEC-20260701-003
- Related ids: DEC-20260701-003, LOG-20260813-125256-lunaui, LOG-20260813-131305-grator

## Decision

Make the public catalog the single primary Songbook surface. Search, filters,
account/session state, theme, sync status, and role-aware management entry
points live on the main page. Add, manage, and history tools open as contextual
surfaces from that page and remain protected by server-side permissions.

The `/admin` path remains a deep-link alias into the same main-page experience
for compatibility. It is not a separate security boundary or a separate page
composition. The old `?tab=settings` query is normalized away because the
former Settings tab contained no implemented operations.

## Context

The original public/admin split kept management controls away from the catalog,
but it also made routine account and song-entry work needlessly separate. The
catalog is the daily workflow and now hosts contextual role-aware tools without
weakening Apps Script or Worker authorization.

## Options Considered

### Keep separate public and admin compositions

- Upside: smaller public surface and a clear visual split.
- Downside: duplicated navigation and account context; management feels
  detached from the catalog workflow.

### Use one main page with contextual management surfaces

- Upside: one search/catalog context, shared account state, and fewer route
  transitions while preserving role-aware server boundaries.
- Downside: modal/deep-link state and focus behavior need testing.

### Move every future owner operation into the main page immediately

- Upside: one place for all tools.
- Downside: it would expose placeholder operations before they have handlers,
  recovery rules, or suitable owner-only UX.

## Rationale

The implemented composition keeps the catalog primary and only exposes
management capabilities that already have real handlers. Contextual surfaces
preserve the speed of public lookup while keeping role checks and audit writes
on the server.

## Consequences

- Product docs should describe one primary route, with `/admin` as a compatible
  alias rather than a separate screen.
- UI verification must cover mobile/desktop sheets, keyboard focus, deep links,
  role-aware controls, and the legacy settings query.
- Future CSV, backup, diagnostics, and cache controls remain deferred until
  they have real authenticated handlers.
