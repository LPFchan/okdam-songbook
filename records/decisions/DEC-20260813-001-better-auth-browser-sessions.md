# DEC-20260813-001: Better Auth Browser Sessions Through the Worker

Opened: 2026-08-13 13-20-00 KST
Recorded by agent: luna-docs

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Supersedes or amends: the web-session portion of DEC-20260701-004
- Related ids: DEC-20260701-004, LOG-20260813-130321-naauth, LOG-20260813-131305-grator

## Decision

Use Better Auth on the existing Cloudflare Worker with D1-backed users,
accounts, and sessions for the browser session path. Google OAuth is handled
under `/api/auth/*`; successful sessions use renewable 14-day HTTP-only cookies.
The Worker exposes the current-session endpoint and a protected browser write
gateway. It derives the actor from the Better Auth session and sends an
internal-secret, Worker-attested actor to Apps Script.

Apps Script remains the final allowlist and role authority during this
migration. The existing GIS ID-token path remains available as an explicit
rollback path. ChatGPT Action OAuth keeps its existing `/authorize`, `/token`,
and `/api/gpt*` contract and is not migrated by this decision.

The source implementation is feature-disabled until D1, secrets, the dedicated
Google OAuth callback, trusted origins, and deployment smoke checks are ready.

## Context

The static GitHub Pages app needs a revocable, multi-day browser session while
keeping the GitHub Free hosting model. Directly sending short-lived Google ID
tokens from the browser works as a rollback path but does not provide an owned
session lifecycle. The Worker already provides a stable integration boundary
for Apps Script and ChatGPT OAuth.

## Options Considered

### Keep GIS as the only browser session

- Upside: no Worker database or cookie deployment work.
- Downside: no owned multi-day session, revocation store, or durable browser
  session independent of the Google browser state.

### Add Better Auth at the Worker and retain GIS during rollout

- Upside: D1-backed revocable sessions, explicit cookie/origin policy, and a
  stable gateway without moving the static frontend.
- Downside: requires D1 migrations, secrets, OAuth callback configuration,
  cross-origin cookie testing, and a rollback contract.

### Move all role authority into Better Auth

- Upside: one apparent authorization store.
- Downside: it would duplicate and weaken the existing Apps Script allowlist
  authority during migration.

## Rationale

The Worker is already the integration boundary, so adding Better Auth there
keeps browser-session concerns separate from public reads and the existing
ChatGPT OAuth protocol. HTTP-only cookies avoid browser-readable bearer
credentials. Keeping Apps Script authoritative limits migration risk and lets
the operator disable the new path without changing Sheet permissions.

## Consequences

- Production enablement requires D1 creation, the checked-in migration, a
  strong `BETTER_AUTH_SECRET`, Google OAuth client/callback setup, and exact
  trusted origins.
- The Pages app must use `credentials: include` for Better Auth requests.
- Protected Worker responses must remain outside service-worker and IndexedDB
  caches.
- `VITE_AUTH_ENABLED=false` and the GIS path remain the safe default until the
  operator completes the rollout checklist.
