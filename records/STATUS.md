# Songbook Status

Opened: 2026-07-01 00-00-00 KST
Recorded by agent: codex-orchestrator

## Snapshot

- Last updated: 2026-08-13.
- Overall posture: `source-integrated; production rollout pending`.
- Integrated source baseline: commits through `5be715a` (`Integrate auth TJ
  and unified UI`).
- Current product shape: one catalog-first main surface with contextual
  account, add, manage, and history tools; `/admin` is a compatibility alias.
- Current production reality: the previously deployed GIS/direct Apps Script
  path and separate ChatGPT OAuth Worker remain the live external components.
  The new Better Auth browser path and TJ Apps Script actions are not live.
- Verification on the integrated source: lint, typecheck, tests, build,
  Apps Script syntax checks, and Wrangler dry-run pass.

## Integrated Source

### Unified web surface

- `apps/web/src/routes/PublicPage.tsx` owns the catalog, quick filters, account
  surface, role-aware management entry points, and contextual management
  sheets.
- `apps/web/src/routes/AdminPage.tsx` supplies add/manage/history content to
  the main surface. It is no longer a separate page composition.
- `/admin?tab=settings` is normalized away because the former Settings tab had
  no implemented operations.

### TJ-assisted entry

- `packages/shared/src/tj.ts` defines bounded lookup/search/candidate contracts
  and parsing helpers.
- Apps Script source implements fixed-host TJ HTML fetching, 30-second cache,
  throttling, parser-drift/upstream errors, exact lookup, bounded search,
  duplicate-safe immediate add, and owner restore.
- Web code uses authenticated actions and keeps manual add/edit available.
- The updated Apps Script has not been pushed, deployed, or live-smoked.

### Better Auth foundation

- The Worker has request-scoped Better Auth 1.6.27 configuration with Google,
  D1, `/api/auth/*`, `/api/session`, and `/api/browser/*` gateway routes.
- Sessions are configured for 14-day expiry with 1-day renewal age and
  credentialed cross-origin cookies.
- Apps Script receives only a Worker-attested actor through the existing
  internal-secret pattern, then independently resolves `ALLOWED_USERS_JSON`.
- GIS direct-token handling remains available as rollback. ChatGPT `/authorize`,
  `/token`, and GPT action routes remain separate.
- `BETTER_AUTH_ENABLED=false` is the checked-in Worker default and the web
  Better Auth client is opt-in through `VITE_AUTH_ENABLED` plus
  `VITE_AUTH_BASE_URL`.

## Production Blockers

1. Provision a Cloudflare D1 database and bind it as `AUTH_DB`.
2. Apply `integrations/chatgpt-proxy/migrations/0001_better_auth.sql` to the
   remote D1 database.
3. Store a strong `BETTER_AUTH_SECRET`; keep existing ChatGPT/Gateway secrets
   separate.
4. Create a dedicated Google OAuth web client for Better Auth and register the
   exact Worker callback `/api/auth/callback/google`. Do not reuse the
   ChatGPT callback contract.
5. Decide and provision the production same-site/custom-domain posture for
   the Pages app and Worker. Verify `SameSite=None; Secure` cookies from the
   actual browser origin before enabling the feature.
6. Set exact `AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_URL`, and Pages
   `VITE_AUTH_ENABLED=true` / `VITE_AUTH_BASE_URL` values. Keep
   `VITE_AUTH_LEGACY_GIS_FALLBACK=true` during rollout.
7. Push and deploy the updated Apps Script source, including TJ actions and
   browser-session actor admission; verify its `INTERNAL_PROXY_SECRET` and
   allowlist properties.
8. Run the staged browser, TJ, PWA-cache, and ChatGPT regression smoke before
   enabling Better Auth traffic. No production deployment has been attempted
   by this work.

## Rollback

- Set `BETTER_AUTH_ENABLED=false` and rebuild Pages with GIS fallback enabled.
- Keep Apps Script's existing ID-token path available until the cookie gateway
  and Sheet actor checks pass live smoke.
- Leave ChatGPT Action OAuth unchanged while browser auth is rolled out.

## Historical Data and Deployment Notes

The July seed/import and existing production bindings remain historical
operational context. The executable current rollout sequence, without secret
values, is [docs/ops-checklist-2026-08-13.md](../docs/ops-checklist-2026-08-13.md).
