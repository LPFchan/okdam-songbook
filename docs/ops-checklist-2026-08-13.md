# Production Rollout Checklist (2026-08-13)

This is the current operator checklist for the source-integrated unified UI, TJ-assisted entry, and Better Auth foundation. Source implementation is complete; production is still on the deployed GIS/direct Apps Script path until these steps are completed. Do not place secret values or credential files in the repository.

## 1. Confirm the release boundary

- [ ] Confirm the integrated source revision has passed the repository lint, typecheck, test, and build checks.
- [ ] Confirm the existing ChatGPT `/authorize`, `/token`, and GPT action behavior remains a separate surface.
- [ ] Choose the final browser origin before provisioning OAuth and cookies. Use either the GitHub Pages origin or a custom domain consistently; do not mix origins during the first rollout.

## 2. Provision Worker and D1

From `integrations/chatgpt-proxy/`:

- [ ] Create the production D1 database with the name `songbook-auth` and retain the returned database ID in the operator's secret/configuration system.
- [ ] Bind that database as `AUTH_DB` in the deployment environment. Keep the real `database_id` out of committed files.
- [ ] Apply the checked-in Better Auth migration with Wrangler's remote D1 migration command for `songbook-auth`.
- [ ] Set a strong random `BETTER_AUTH_SECRET`.
- [ ] Set the Worker values for `BETTER_AUTH_URL` and `AUTH_TRUSTED_ORIGINS` to the exact final browser origin(s). Include no broad wildcard origin.
- [ ] Keep `BETTER_AUTH_ENABLED=false` until the full smoke matrix below passes against the deployed Worker.
- [ ] Set the existing Worker values separately: Apps Script URL and internal proxy secret, allowlisted role emails, cookie secret, and ChatGPT OAuth client values.

## 3. Provision the dedicated Google OAuth client

- [ ] Create or select a Google OAuth web client dedicated to Better Auth browser sessions. Do not reuse the ChatGPT OAuth client.
- [ ] Register the exact callback `<auth-origin>/api/auth/callback/google`.
- [ ] Register the exact browser origin(s) used by the Pages deployment.
- [ ] Store the client ID and client secret in the Worker environment as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; do not put them in source or Pages HTML.

## 4. Update and deploy Apps Script

- [ ] Set `INTERNAL_PROXY_SECRET` in Apps Script Script Properties to the same operator-managed value as the Worker.
- [ ] Confirm `ALLOWED_USERS_JSON`, `ALLOWED_ORIGINS`, spreadsheet ID, and production environment values.
- [ ] Push the current `apps-script/src/` source, run `setupSpreadsheet()` and `validateSpreadsheetSchema()`, and deploy the web app as the existing `/exec` endpoint.
- [ ] Smoke the legacy GIS actions and the new internal actor gateway before enabling browser sessions.
- [ ] Confirm TJ actions use the fixed `https://www.tjmedia.com/song/accompaniment_search` host and that no browser request can provide its own actor, email, or role.

## 5. Configure and publish Pages

- [ ] Keep `VITE_APPS_SCRIPT_API_URL` and `VITE_GOOGLE_CLIENT_ID` configured for the explicit GIS rollback path.
- [ ] Set `VITE_AUTH_BASE_URL` to the Worker auth origin.
- [ ] Initially set `VITE_AUTH_ENABLED=false` and `VITE_AUTH_LEGACY_GIS_FALLBACK=true` for the first Pages build.
- [ ] After Worker and Apps Script smoke passes, publish a controlled build with `VITE_AUTH_ENABLED=true`. Keep the GIS fallback available during the observation window.
- [ ] If using cross-site GitHub Pages and Worker origins, verify that credentialed fetch is enabled and that cookies are `SameSite=None; Secure; HttpOnly`; a same-site custom domain may simplify this boundary but does not remove the exact-origin checks.

## 6. Run the smoke matrix

- [ ] Public song reads work anonymously.
- [ ] Anonymous browser gateway calls fail with `401`; untrusted origins fail preflight/admission.
- [ ] An allowlisted Google user can sign in, read `/api/session`, reload, renew, and sign out. No bearer token appears in localStorage, sessionStorage, IndexedDB, URLs, or service-worker caches.
- [ ] Apps Script resolves the allowlist and role for the Worker-attested actor; browser-supplied actor/email/role fields are ignored.
- [ ] Revoked/unknown users and expired sessions are rejected; protected responses are not cached.
- [ ] TJ exact lookup, bounded search, Unicode input, no-result, upstream failure, throttling, and parser-drift cases have safe outcomes.
- [ ] TJ immediate add records provenance and idempotency; duplicate and deleted-match restore behavior work; manual entry remains available.
- [ ] ChatGPT `/authorize`, `/token`, and GPT action regression checks pass unchanged.
- [ ] Verify the main catalog route, `/admin` compatibility deep link, contextual add/manage/history surfaces, and browser reload behavior.

## 7. Rollback and closeout

- [ ] If any auth smoke fails, set Worker `BETTER_AUTH_ENABLED=false` and publish Pages with `VITE_AUTH_ENABLED=false` and the GIS fallback enabled.
- [ ] Leave the existing ChatGPT OAuth configuration untouched during browser-auth rollback.
- [ ] Record the deployed Worker revision, D1 migration result, Apps Script deployment version, Pages build, smoke evidence, and any follow-up hardening in the next status update.

