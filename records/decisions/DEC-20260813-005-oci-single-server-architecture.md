# DEC-20260813-005: OCI Single-Server Songbook Architecture

Opened: 2026-08-13 16-52-30 KST
Recorded by agent: luna-records

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Supersedes: DEC-20260701-001, DEC-20260701-005, DEC-20260813-001
- Related ids: RSH-20260813-002, RSH-20260813-001

## Decision

Host the Songbook frontend, backend API, Better Auth, SQLite database, TJ
adapter, and stateless MCP endpoint together in one Dockerized application on
OCI, reached through the existing Cloudflare Tunnel. The application uses a
same-origin browser API and secure HTTP-only Better Auth cookies. The catalog
remains anonymously readable; protected writes and management operations
require a Google-backed session.

The current email allowlist and role are authoritative on every protected
request, including requests carrying an otherwise-valid Better Auth session.
Mutation endpoints enforce CSRF/Origin boundaries. Performers remain separate
from authenticated users. SQLite owns songs, performances, users/sessions,
idempotency keys, and audit events; imported ChangeLog history is retained.
HTTP routes and MCP tools share domain services and their validation,
permission, duplicate, version, idempotency, and audit behavior.

The MCP endpoint is stateless and negotiates the protocol revision requested by
each client, including MCP 2.0 stateless support. MCP bearer/OAuth access is
kept separate from browser cookie auth. Existing ChatGPT Actions and all legacy
source and production systems remain live until an operator-gated cutover and
30-day observation window are complete.

## Context

The Pages/Worker/Apps-Script/Sheets topology spreads one small application over
four deployment and data authorities. It creates cross-origin browser auth,
multiple write boundaries, and no durable database model. OCI already provides
the hosting target and Tunnel ingress needed for a single operational surface.

Two high-effort architecture reviews identified mandatory release gates:
repeatable import and reconciliation, backups with a proven restore,
per-request authorization and CSRF protection, a real offline queue drain,
actual-client MCP verification, one dependency/toolchain substrate, Pages
service-worker cleanup, preservation of legacy source, and ARM64 build gating.

## Options Considered

### Keep Pages, Worker/D1, Apps Script, and Sheets

- Upside: smallest immediate code change and familiar Sheet inspection.
- Downside: preserves distributed authority, cross-origin cookie risk, and
  operational complexity that motivated the refactor.

### Move only the database to a managed service

- Upside: reduces Sheet coupling.
- Downside: leaves the Worker, Apps Script, Pages, and duplicated auth/API
  boundaries in place.

### Use one OCI application with SQLite

- Upside: one origin, one service layer, one operational database, simple
  backups, and shared browser/MCP behavior at the project’s scale.
- Downside: OCI operations now own availability, backups, upgrades, and
  recovery; these must be proven before cutover.

## Rationale

SQLite is appropriate for the small catalog and audience when paired with WAL,
foreign keys, a busy timeout, safe backups, and restore drills. A single
same-origin service makes browser authentication and API contracts simpler,
while shared domain services prevent MCP and browser behavior from drifting.
Keeping the allowlist check per request preserves immediate revocation instead
of trusting a stale session role. The 30-day observation and retained legacy
systems provide rollback evidence without introducing dual-write conflicts.

## Consequences

- The implementation plan and worker boundaries are recorded in
  `RSH-20260813-002`.
- A repeatable importer, reconciliation report, and owner CSV workflow replace
  Sheet-based operational inspection.
- OCI must provide container health monitoring, backups, restore evidence,
  secret management, logs, restart policy, and an ARM64 build/start gate;
  amd64 local verification is useful where available.
- Push-triggered Pages auto-deploy is disabled in Wave 0, before any
  application code lands. During the operator-gated cutover, a final Pages
  cleanup artifact is published manually to unregister service workers, clear
  old caches, and redirect to OCI.
- TJ parsing remains bounded and degradable; manual entry must continue to work
  through upstream failure.
- Retirement of Worker/D1, Apps Script, Sheets, Pages, or legacy integrations
  is deferred to an explicit operator decision after observation.
