# Songbook Plans

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Approved Directions

### Initial Working Product

- Outcome: A deployable GitHub Pages PWA with typed shared logic and Apps Script backend source.
- Why this is accepted: It satisfies the GitHub Free constraint while keeping private operational data in Google Sheets.
- Expected value: Immediate local/mock usage and clear path to production deployment.
- Preconditions: Repo-template adoption and research artifacts.
- Earliest likely start: now.
- Related ids: DEC-20260701-001, DEC-20260701-002

### External Production Binding

- Outcome: Connect real OAuth client, Apps Script Web App URL, private Sheet, and allowed users.
- Why this is accepted: Real writes and admin auth require operator-owned Google resources.
- Expected value: Full end-to-end deployment.
- Preconditions: OAuth client is configured; Apps Script Web App URL, private Sheet, and allowed users remain.
- Earliest likely start: after initial build passes.
- Related ids: RSH-20260701-001, RSH-20260701-002

## Sequencing

### Near Term

- Initiative: Complete implementation and local verification.
  - Status: `done`
  - Why now: It removed repo-local blockers and produced a buildable GitHub Pages PWA.
  - Dependencies: complete.
  - Related ids: DEC-20260701-001 through DEC-20260701-008

### Mid Term

- Initiative: Deploy Apps Script and Pages with production env values.
  - Status: `OAuth configured; waiting on Apps Script and Sheet settings`
  - Why later: Needs Apps Script deployment, Sheet setup, and allowlist values.
  - Dependencies: Script Properties, Sheet ID, Apps Script Web App URL, allowed user emails.
  - Related ids: RSH-20260701-001 through RSH-20260701-008

### Deferred But Accepted

- Initiative: Real AI provider smoke tests.
  - Why deferred: Requires provider API key and operator acceptance of cost/privacy tradeoffs.
  - Revisit trigger: `AI_PROVIDER` and `AI_API_KEY` are configured.
  - Related ids: DEC-20260701-008

## Accepted Refactor Direction (2026-08-13)

### TJ-Assisted Discovery and Song Entry

- Outcome: Authenticated editors can autofill from an exact TJ number, search TJ accompaniment results, and add a selected result with one action while retaining manual correction, provenance, audit history, and server-side duplicate protection.
- Included outcomes: (1) live TJ website search query, (2) one-click add from a TJ search result, and (3) title/artist autofill from a TJ karaoke number.
- Status: `accepted outcome; architecture and reuse decision-gated`
- Recommended default: Use one authenticated, fixed-host Apps Script adapter that parses TJ's public result HTML into a typed candidate. Implement exact-number autofill first, broad search second, and one-click add third. The browser never fetches or embeds TJ directly.
- Decision gate: Accept the low-volume public-HTML reuse/fragility posture and pass a deployed Apps Script fetch spike. If that spike fails, choose a separate bounded proxy or stop; do not silently change architecture.
- Dependencies: TJ candidate contract and fixtures, request bounds, permission checks, cache/throttle policy, structured upstream errors, duplicate policy, and manual fallback.
- Exit criteria: Exact lookup, broad Unicode search, no-result and parser-drift behavior, and one-click idempotency pass automated tests and a deployed smoke; manual add remains usable throughout upstream failure.
- Related ids: RSH-20260813-001, DEC-20260701-001, DEC-20260701-006, DEC-20260701-007

### Login Continuity and Authentication Architecture

- Outcome: Returning allowed users get the operator-selected login continuity, with an explicit fallback and server-authoritative role checks.
- Included outcomes: (4) login state persistence and (5) a gated Better Auth implementation path.
- Status: `accepted outcome; persistence promise and architecture decision-gated`
- Recommended default: Choose improved GIS startup restoration when best-effort reacquisition from the current Google browser session is sufficient. Choose Better Auth only for an owned, revocable, multi-day Songbook session.
- Better Auth option: Viable as Cloudflare Worker + D1 + dedicated Google OAuth client + HTTP-only session cookie + protected Apps Script gateway. It is not approved architecture. Same-site app/auth hostnames, session policy, allowlist authority, migrations, browser testing, and rollback are prerequisites.
- Boundaries: Never persist Google ID tokens in browser-readable storage. Keep Apps Script's current allowlist and permission check authoritative during an initial migration. Keep ChatGPT Action OAuth separate in the first rollout.
- Dependencies: Operator-selected persistence promise and architecture; Better Auth additionally requires an architecture decision, feasibility spike, same-site domain posture, D1/OAuth provisioning, and rollback contract.
- Exit criteria: Reload, browser restart, expiry, logout, revoked/removed user, offline startup, and fallback behavior match the selected promise across the supported browser matrix; protected responses are excluded from PWA caching.
- Related ids: RSH-20260813-001, DEC-20260701-004

### Main-Page Filters and Settings Consolidation

- Outcome: Common catalog filters are accessible chips, the complete filter set remains available in a responsive sheet/modal, and the unused Admin `고급 설정` tab is removed.
- Included outcomes: (6) filters presented as chips and (7) Settings controls consolidated into the main-page experience where suitable.
- Status: `accepted outcome; quick-chip details and page-merger scope decision-gated`
- Recommended default: Show the three performers, favorite, and practicing in one horizontally scrollable quick row; keep country, genre, and has-key in the complete chip sheet; keep sort separate; preserve current reset-on-reload filter behavior initially.
- Recommended default: Remove only the no-op Settings tab. Put account/login, explicit theme choice, and sync details in a contextual main-page surface. Keep future CSV, backup, diagnostics, and cache operations in an authenticated owner operations surface once they have real handlers.
- Decision gate: A full merge of add/manage/history into the main page requires a decision that supersedes DEC-20260701-003. It is not implied by Settings-tab removal.
- Dependencies: Quick-chip and filter-persistence choices, the settled auth-provider contract, and the narrow/full Settings-scope decision.
- Exit criteria: Filter semantics, removal/reset, result counts, responsive layout, keyboard/focus behavior, role-aware account controls, and the legacy `?tab=settings` fallback pass tests and mobile/desktop smoke.
- Related ids: RSH-20260813-001, DEC-20260701-003

## Refactor Fan-Out Execution Plan

Parallel owners must stay within the named surfaces. Any shared-file boundary is assigned to one integration owner or landed before dependent composition begins.

### Wave 0 — Decisions and Live Spikes

- Owner: refactor coordinator.
  - Work: Record the TJ reuse posture, one-click publication policy, login persistence promise and GIS/Better Auth choice, quick-chip defaults, filter persistence choice, and narrow/full Settings scope.
  - Status: `pending operator decisions`
  - Dependencies: RSH-20260813-001.
  - Exit: Each gate has an explicit answer; architecture-changing choices receive decision records before implementation.
- Owner: TJ spike worker.
  - Work: Run deployed Apps Script fetches for exact number, broad Korean/Latin/Japanese queries, and no result; capture sanitized fixtures, timing, response shape, and blocking/rate observations.
  - Status: `blocked by TJ reuse approval`
  - Dependencies: TJ reuse posture.
  - Exit: Apps Script suitability is evidenced and the candidate/error/cache contract is ready, or a fallback/stop decision is escalated.
- Owner: auth feasibility worker, only if Better Auth is selected.
  - Work: Prove same-site domain/cookie behavior, Worker runtime, D1 migration path, trusted origins, and GIS rollback in a non-production environment.
  - Status: `conditional`
  - Dependencies: persistence promise and Better Auth architecture approval.
  - Exit: The selected browser/session promise is feasible before production auth traffic changes.

### Wave 1 — Shared Foundations

- Owner: TJ contract/parser worker.
  - Work: Own shared TJ request/result schemas, sanitized HTML fixtures, parser, normalization, provenance mapping, paging metadata, and parser-drift errors.
  - Status: `pending Wave 0`
  - Dependencies: successful TJ spike and accepted candidate contract.
  - Exit: Ordinary, Unicode, highlighted/icon, empty, multiple, pagination, and malformed fixtures produce deterministic candidates or explicit errors.
- Owner: auth foundation worker.
  - Work: Implement the selected provider-neutral auth/session contract. GIS path owns startup reacquisition and logout suppression; Better Auth path owns Worker/D1 session lifecycle, admission, and rollback foundation.
  - Status: `pending architecture gate`
  - Dependencies: selected auth architecture; Better Auth path also depends on its feasibility spike and decision record.
  - Exit: Auth lifecycle tests pass without changing page composition; no browser-readable persisted credential is introduced.
- Owner: filter primitive worker.
  - Work: Own filter descriptors/state transitions, semantic chip and group primitives, dynamic-option ordering, active-count/removal/reset behavior, and focused unit tests.
  - Status: `ready after quick-chip decision`
  - Dependencies: quick-chip and filter-persistence choices.
  - Exit: Country/genre remain single-select, performers preserve OR semantics, booleans combine independently, and accessible chip behavior is tested.

### Wave 2 — Feature Composition and Integration

- Owner: TJ service integration worker.
  - Work: Own authenticated Apps Script lookup/search actions, fixed-host fetch, cache/throttle, API client adapters, exact-number draft autofill, broad result UI, paging, and saved-song duplicate markers.
  - Status: `pending TJ foundation`
  - Dependencies: Wave 1 TJ schemas/parser and the stable auth permission interface.
  - Exit: Authenticated exact lookup and broad search work end to end; upstream errors preserve manual add and local browsing.
- Owner: auth web integration worker.
  - Work: Connect the selected auth foundation to web protected actions and neutral account state while preserving the old path behind rollback when Better Auth is selected.
  - Status: `pending auth foundation`
  - Dependencies: Wave 1 auth lifecycle; Better Auth path also needs the Apps Script gateway and origin/cookie configuration.
  - Exit: Current-user and protected-action flows pass authorization, expiry, fallback, and rollback tests.
- Owner: public filter composition worker.
  - Work: Own `PublicPage` filter layout and public-page filter CSS: one-line quick chips, complete responsive sheet/modal, active-filter summary, focus behavior, and result/empty states.
  - Status: `pending filter primitives`
  - Dependencies: Wave 1 filter contract.
  - Exit: Mobile and desktop touch/keyboard/zoom smoke passes without expanding the sticky header into multiple wrapped rows.

### Wave 3 — One-Click Add and Account/Settings Consolidation

- Owner: TJ add worker.
  - Work: Own result-row add state, stable retry ID, conservative Song defaults, server-authoritative duplicate outcomes, ChangeLog verification, local refresh, and edit-existing/edit-new affordances.
  - Status: `pending stable TJ search`
  - Dependencies: Wave 2 TJ integration, selected publication/deleted-row policy, and working auth flow.
  - Exit: Repeated clicks or uncertain retries create at most one audited song; duplicates never overwrite; the new song appears without reload.
- Owner: main-page account/settings worker.
  - Work: Own public account/overflow composition, login/re-login/logout, explicit theme and sync details, removal of the no-op admin Settings tab, and legacy query fallback. Do not move unimplemented owner operations.
  - Status: `pending auth integration and Settings-scope gate`
  - Dependencies: Wave 2 auth integration and the narrow/full merger decision.
  - Exit: Anonymous, reauth-required, editor, and owner states work on mobile and desktop; `/admin?tab=settings` falls back safely.

### Wave 4 — Hardening, Operations, and Documentation

- Owner: verification worker.
  - Work: Run parser drift, upstream outage, duplicate race/retry, auth/browser/security, accessibility, responsive, offline/PWA cache, full test, typecheck, lint, build, and deployed smoke matrices.
  - Status: `pending feature completion`
  - Dependencies: Waves 2 and 3.
  - Exit: Every initiative's exit criteria pass, failure modes retain manual/recovery paths, and no protected response or credential enters a cache or log.
- Owner: documentation and records worker.
  - Work: Update canonical API, architecture, security, deployment, operations, SPEC, STATUS, and decisions only for behavior and architecture that have actually landed and been accepted.
  - Status: `pending verified implementation`
  - Dependencies: verification evidence and operator acceptance.
  - Exit: Durable truth matches production behavior; TJ parser maintenance, auth rollback/session operations, and user-facing fallbacks are documented without promoting rejected options.

### Coordination Rules

- TJ exact-number autofill precedes broad search integration; one-click add follows stable lookup/search behavior.
- Account/settings composition follows the auth-provider contract, so GIS and Better Auth internals do not leak into page structure.
- Filter primitives land before the public-page layout worker edits `PublicPage`; the public layout owner also owns shared public filter styling for that wave.
- Workers produce evidence and bounded implementation. The coordinator resolves cross-surface contracts and owns truth-record updates.
