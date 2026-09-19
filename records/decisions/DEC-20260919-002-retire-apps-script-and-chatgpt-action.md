# DEC-20260919-002: Retire the Apps Script Backend, the ChatGPT Action, and the Node Storage Path

Opened: 2026-09-19 11-00-00 KST
Recorded by agent: claude

## Metadata

- Status: accepted
- Deciders: operator
- Supersedes: DEC-20260701-001 (GitHub Pages + Sheets + Apps Script) and
  DEC-20260701-005 (Sheets as source of truth) as anything still in the tree;
  the "kept pending a decision" items in DEC-20260919-001's consequences
- Related ids: DEC-20260813-005, DEC-20260914-001, DEC-20260919-001

## Decision

The following are removed from the repository rather than kept as dormant
code:

- `apps-script/` (the Google Sheets backend) and its hand-mirrored tests
  in `packages/shared/test/{chatgpt,lock}.test.ts`;
- `integrations/chatgpt-proxy` (the ChatGPT Actions OAuth bridge), the
  Action's OpenAPI document, setup guide and Custom GPT instructions under
  `docs/`;
- `packages/songbook-admin`, `scripts/import-csv.mjs`,
  `packages/server-core/src/migration.ts` and `packages/shared/src/csvImport.ts`
  (the Sheets-to-SQLite import/export tools);
- the better-sqlite3 + drizzle storage path in `packages/server-core`
  (`openDatabase`, the numbered migration chain, the drizzle schema) and the
  Node static-file path in `apps/server`;
- the pre-Common-Auth session-token helpers in `packages/shared/src/auth/`.

The identity-header decoder in `apps/server/src/auth.ts` is replaced by the
shared `@lpfchan/gateway-identity` package (v1.0.0), the same one the other
lost.plus Workers use.

## Context

DEC-20260919-001 made Workers the only production shape and listed these as
leftovers pending a decision. None of them can reach D1: the admin and import
tools operate on a SQLite file that no longer receives writes, the ChatGPT
Action targets an Apps Script deployment that is gone, and the proxy Worker
was never deployed in the operator's account. The operator asked for dead
code to be cleaned up everywhere.

The Node storage path was still exported from `packages/server-core`'s main
entry, so the Worker bundle carried drizzle and better-sqlite3's loader
(1739 KiB before, 1637 KiB after; gzip 312 KiB to 293 KiB — the
remaining weight is the MCP SDK, zod and hono). Its only callers
were tests.

## Options Considered

### Keep the tools as Node-only utilities

- Downside: they cannot be run against production data, so they are code
  that looks usable and is not
- Downside: every doc has to explain what they are for

### Port the import/export tools to D1

- Rejected: there is no import left to do; the catalogue was migrated on
  2026-09-18 and D1 exports and Time Travel cover backup and restore

### Remove them and move the tests onto the D1 fake

- Upside: one storage runtime in code and in tests; a green `verify` says
  the Worker runtime works
- Downside: tests that asserted Node-only guarantees go away (see below)

## Rationale

The retained code described a product that no longer exists. Removing it
makes the docs true, shrinks the bundle, and leaves one executor to reason
about. Adopting the shared identity parser removes a per-repo copy of logic
whose contract is owned by the auth hub.

## Consequences

- `apps/server` test and `packages/server-core` tests run on a
  better-sqlite3-backed fake of the D1 binding (`test/fake-d1.ts`) with
  foreign keys on, as D1 enforces them. `better-sqlite3` stays as a
  devDependency for that reason only.
- Dropped tests: pragma/WAL/migration-chain checks (Node-only), the static
  SPA fallback and frame-header tests in `apps/server` (covered by
  `apps/worker/test`), and "rolls back the mutation and idempotency claim
  when audit writing fails". That last one asserted a rollback D1 cannot
  perform; `packages/server-core/test/d1.test.ts` already asserts the
  opposite, and `docs/deployment.md` documents the partial-failure shape.
- `SqlExecutor` loses `exec()` and `writeProbe()`; `/healthz` checks
  reachability only.
- `normalizeEmail` moves to `packages/shared/src/normalize.ts`.
- `npm run build:runtime` now builds `@songbook/server` too, so a fresh
  checkout can run `npm run verify` without a manual `npm run build` first.
- Historical DECs and RSHs about Sheets, Apps Script and the Action stay as
  records of how the product got here.
