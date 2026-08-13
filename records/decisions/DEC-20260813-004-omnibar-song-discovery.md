# DEC-20260813-004: Omnibar Song Discovery and Add

Opened: 2026-08-13 13-52-00 KST
Recorded by agent: codex-orchestrator

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Supersedes: the add-navigation portion of DEC-20260813-002
- Related ids: DEC-20260813-002, DEC-20260813-003

## Decision

Use the main catalog search input as an omnibar. Every query filters the saved
Songbook immediately. For authenticated editors, a 450 ms debounce then sends
the same query to the bounded TJ search adapter. Saved-song matches remain the
first result section; TJ candidates appear as a separate continuation after
them.

A new TJ candidate can be added immediately from its row. A candidate that
matches a saved song opens that song instead of offering another add. Manual
entry remains available as a fallback from the TJ continuation. Song add is not
an account/settings navigation item. Manage and history remain secondary
utilities reachable directly from the catalog toolbar.

## Context

Putting add, manage, and history behind Account → Settings made the primary
song-discovery and registration workflow feel administrative. Searching the
local catalog and searching TJ are one user intent: find a song, then use the
saved entry or add the external candidate.

## Options Considered

### Keep add inside the account/settings surface

- Upside: management controls share one container.
- Downside: song discovery and entry require unrelated navigation steps.

### Add a separate TJ search screen

- Upside: clear technical separation.
- Downside: duplicates the main query and splits local and external results.

### Use the catalog search as an omnibar

- Upside: local matches respond immediately, TJ extends the same intent after
  a debounce, and adding happens at the point of discovery.
- Downside: the result hierarchy and asynchronous states need explicit visual
  treatment.

## Rationale

The omnibar keeps existing data authoritative and fastest while making TJ a
natural fallback instead of a separate tool. Debouncing limits upstream load,
and local-first ordering prevents external results from displacing known songs.

## Consequences

- Authenticated queries of two or more characters, or any numeric query, start
  a debounced TJ search.
- Local matches always render before TJ candidates.
- Add/duplicate/error state is attached to each TJ row.
- Manual entry remains a fallback rather than the primary add route.
- Account/preferences contains account and preference controls, not song-add
  navigation.
