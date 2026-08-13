# Songbook Plans

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Accepted Directions

### Unified catalog-first surface

- Status: `implemented in source; production verification pending`.
- Main catalog owns account, filters, theme, sync, and role-aware contextual
  entry to add/manage/history tools.
- `/admin` remains a compatibility alias rather than a separate composition.
- Related ids: DEC-20260813-002.

### TJ-assisted discovery and entry

- Status: `implemented in source; Apps Script deployment and smoke pending`.
- Exact lookup, bounded Unicode search, editable autofill, immediate add,
  duplicate outcomes, provenance, replay safety, and deleted-row restore are
  implemented behind authenticated Apps Script actions.
- Manual entry remains the fallback for no-result, upstream, throttle, and
  parser-drift outcomes.
- Related ids: DEC-20260813-003.

### Better Auth browser sessions

- Status: `implemented in source; provisioning and rollout pending`.
- Worker/D1 Better Auth source, migrations, cookie/origin settings, browser
  gateway, Apps Script actor admission, web transport, and GIS rollback are in
  place.
- Better Auth is disabled by default until the production checklist is complete.
- Related ids: DEC-20260813-001.

## Remaining Rollout Sequence

1. Provision D1, apply the checked-in migration, and store the Better Auth
   secret.
2. Create the dedicated Google OAuth client and register the exact Worker
   callback. Confirm the final app/Worker origin posture before cookie testing.
3. Set Worker vars/secrets and Pages auth variables while leaving Better Auth
   disabled.
4. Push/deploy Apps Script TJ and browser-gateway source; verify allowlist,
   internal secret, Sheet schema, and public reads.
5. Smoke exact TJ lookup, broad Unicode search, no-result/upstream/parser
   failures, immediate add/duplicate/restore, and manual fallback.
6. Smoke anonymous and allowlisted Better Auth session/current-user/gateway
   behavior, logout, expiry/renewal, revoked allowlist entry, and cache
   exclusions.
7. Enable Better Auth in a controlled rollout, rebuild Pages, and retain GIS
   fallback until the browser matrix passes.
8. Re-run the unchanged ChatGPT OAuth regression flow and confirm its routes
   and credentials remain separate.

## Deferred Work

- Real AI provider smoke tests remain deferred until provider credentials and
  cost/privacy acceptance exist.
- CSV import/export, backup, diagnostics, and cache-reset operations remain
  deferred until they have real authenticated handlers and recovery rules.
- TJ parser maintenance and upstream compatibility review follow the fixed-host
  contract and parser-drift tests.

## Verification Ownership

- Auth rollout owner: verify D1 migrations, exact origins/cookies, session
  lifecycle, Worker gateway admission, Apps Script role resolution, and PWA
  cache exclusions.
- TJ rollout owner: verify deployed Apps Script fetches and normalized outcomes
  against exact-number, Unicode, empty, upstream-error, throttle, and markup
  drift cases.
- Integration owner: verify catalog state refresh after add/restore and run
  ChatGPT OAuth regression without changing its protocol.
