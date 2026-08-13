# RSH-20260813-002: OCI Single-Server Refactor and Fan-Out Plan

Opened: 2026-08-13 16-52-00 KST
Recorded by agent: luna-records

## Question

How should Songbook move from GitHub Pages, Cloudflare Worker/D1, Apps Script,
and Google Sheets to one OCI-hosted application while preserving the current
user-facing and integration contracts during a controlled cutover?

## Accepted Target

Run the React frontend, Node HTTP API, Better Auth, SQLite database, TJ adapter,
and stateless MCP endpoint in one Dockerized application on OCI. Use the
existing Cloudflare Tunnel for public ingress and TLS. Keep the catalog
anonymous for reads; require Google-backed Better Auth sessions for protected
browser actions. The SQLite database is the operational source of truth for
songs, performances, users, sessions, idempotency keys, and audit events.

The browser uses same-origin JSON and HTTP-only cookies. Better Auth sessions
are checked against the authoritative per-request email allowlist and current
role, so an existing session cannot outlive a revoked user. Mutation routes
enforce Origin checks and CSRF boundaries. Performers are song-domain records,
separate from authenticated users. HTTP routes and MCP tools call the same
domain services for validation, permissions, duplicate handling, optimistic
versions, idempotency, and audit writes.

MCP is exposed at the application origin as a stateless endpoint. It negotiates
the protocol revision requested by the client, supports the MCP 2.0 stateless
shape, and retains compatibility with the supported legacy stateless clients.
Bearer/OAuth access is separate from browser cookie authentication. Existing
ChatGPT Actions remain live and compatible until the operator authorizes their
replacement.

## Data Model Direction

- `songs`: nullable unique `tj_number`, song metadata, JSON fields for small
  bounded collections, lifecycle status, timestamps, and optimistic `version`.
- `performances`: song reference, date/key/memo, cancellation fields,
  `client_request_id`, and optimistic `version`; index `(song_id, cancelled_at)`.
- `users` and Better Auth tables: identity/session/account data plus role;
  the allowlist remains an authoritative current-access check.
- `idempotency_keys`: request key, actor, operation, response, and expiry;
  replay detection does not depend on audit history.
- `audit_events`: complete imported ChangeLog and all new before/after changes,
  actor, request key, and version transition.

Calculate performance counts and last-performed values from performances rather
than storing denormalized copies. Enable SQLite foreign keys, WAL,
`synchronous=NORMAL`, and a bounded busy timeout on every connection. Decide
and document whether a soft-deleted song continues reserving its TJ number
before migration code treats that constraint as final.

## Corrected Fan-Out Waves

Parallel workers may implement only after the shared contract and gates below
are accepted. The orchestrator owns the integration branch, database migration
ordering, and final cutover decision.

### Wave 0 — Contract and substrate gate

1. Freeze the existing Pages deployment and disable Pages auto-deploy before
   changing application code. Preserve all legacy source and deployment
   configuration for rollback.
2. Commit the shared API/auth/MCP contract: schemas, error envelope, roles,
   scopes, idempotency semantics, version conflicts, public-read policy,
   performer/user distinction, and the supported MCP negotiation matrix.
3. Choose one repository dependency/toolchain substrate and make Docker,
   local development, tests, and all workers use it. Use amd64 local
   verification where available, but require an ARM64 OCI build and start
   gate; ARM64 failure blocks release.
4. Spike Better Auth OAuth and scopes against the actual MCP clients, including
   the intended MCP 2.0/stateless client and existing ChatGPT Actions. Record
   observed client behavior before assigning MCP implementation work.

### Wave 1 — Foundation and migration evidence

5. Create the SQLite schema, migrations, connection pragmas, health/readiness
   endpoint, and shared domain/service interfaces.
6. Build a repeatable, idempotent Sheet importer. Import Songs, Performances,
   users/allowlist context, and the complete ChangeLog into the new model.
7. Produce a reconciliation report covering row counts, per-song hashes,
   performances, versions, deleted rows, and audit-event completeness. A
   final cutover requires zero unexplained differences.
8. Add safe CSV export and owner-only CSV import with dry-run preview and
   validation. This replaces Sheet inspection/recovery without making CSV the
   operational source of truth.

### Wave 2 — Shared application services

9. Port song, performance, duplicate, restore, permission, audit, and
   idempotency behavior into domain services with focused tests.
10. Add the TJ adapter behind bounded timeouts, response-size limits, caching,
    throttling, and a circuit breaker; retain manual entry when TJ fails.
11. Add Better Auth Google browser sessions with secure cookie settings,
    per-request allowlist/role checks, revocation behavior, and CSRF tests.

### Wave 3 — Client surfaces

12. Implement the same-origin HTTP API and switch the React app to it while
    preserving the API response contracts.
13. Complete the offline queue drain: reconnect replay, bounded retries,
    idempotency, expired-auth recovery, and visible permanent failures. Test
    duplicate replay and version conflicts.
14. Add the owner CSV operations surface and diagnostics needed for recovery;
    do not expose dead settings controls.

### Wave 4 — MCP and operational readiness

15. Implement stateless negotiated MCP tools/resources through the shared
    services. Verify the actual target clients, OAuth discovery, scopes,
    read/write permissions, malformed requests, replay, and protocol fallback.
16. Add automated SQLite-safe backups, retention, backup monitoring, and a
    documented restore drill. Do not cut over until a restore has succeeded.
17. Run end-to-end tests on OCI, including Tunnel ingress, TLS, auth, browser
    reads/writes, offline replay, TJ degradation, MCP, ARM64 image startup,
    logging, health checks, and backup/restore.

### Wave 5 — Operator-gated cutover and observation

18. During the operator-gated cutover, manually publish a final GitHub Pages
    cleanup build that unregisters the service worker, clears old caches, and
    redirects to OCI. Pages push-triggered auto-deploy was disabled in Wave 0,
    before any application code landed; leave the old source and production
    systems untouched.
19. Freeze writes at the Sheet, run the final importer and reconciliation,
    take/export rollback backups, then switch the Tunnel route to OCI.
20. Observe for 30 days with the legacy Worker, Apps Script, Sheet, Pages
    artifact, ChatGPT Actions, and source retained. Compare errors, writes,
    audit events, and user reports; only the operator may authorize retirement.

## Failure Gates and Rejected Shortcuts

No wave may delete the legacy source or live service before cutover and
observation. No worker may invent a parallel schema, auth contract, or direct
database access. No MCP implementation proceeds without the real-client OAuth
spike. No release proceeds without a tested restore, CSRF and revocation tests,
reconciliation evidence, offline replay evidence, or ARM64 image evidence.

The plan deliberately avoids dual-writing during the observation window:
legacy systems remain available for rollback and comparison, while OCI is the
only write target after the operator-gated freeze. Dual-writing would create
conflicting authorities and make reconciliation less trustworthy.

## Open Operator Gates

- final retention period and backup destination;
- exact MCP clients and required OAuth scopes;
- whether soft-deleted songs reserve TJ numbers;
- final allowlist storage and administration workflow;
- exact OCI resource sizing and Docker restart policy.

## Related Records

- Superseding decision: `DEC-20260813-005`.
- Prior exploration: `RSH-20260813-001`.
- Superseded architecture decisions: `DEC-20260701-001`,
  `DEC-20260701-005`, `DEC-20260813-001`.
