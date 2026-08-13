# Deployment

The integrated source is not the same thing as an enabled production path.
Do not enable Better Auth or TJ actions until the dated operator checklist has
been completed and the browser smoke matrix passes.

## Existing production components

- GitHub Pages hosts the static app at the repository's configured Pages URL.
- Apps Script and its private Sheet remain the operational data boundary.
- The Cloudflare Worker keeps the existing ChatGPT OAuth Action routes.
- The new Better Auth browser routes are disabled by default.
- The new TJ Apps Script source is not yet pushed or deployed.

## GitHub Pages

1. Set Pages source to GitHub Actions.
2. Set Actions variables `VITE_APPS_SCRIPT_API_URL` and
   `VITE_GOOGLE_CLIENT_ID` for the existing GIS/direct Apps Script path.
3. Keep `VITE_APP_BASE_PATH=/okdam-songbook/`.
4. For Better Auth rollout, set `VITE_AUTH_ENABLED=true`,
   `VITE_AUTH_BASE_URL=<exact Worker or custom auth origin>`, and keep
   `VITE_AUTH_LEGACY_GIS_FALLBACK=true` during migration.
5. Run the Pages workflow only after the corresponding Worker and Apps Script
   smoke checks pass.

The build runs lint, typecheck, tests, and build before publishing
`apps/web/dist`. Never put a client secret, D1 id, allowlist, or internal proxy
secret in Pages variables.

## Apps Script

1. Create or select the private Sheet and configure `.clasp.json` locally.
2. Set Script Properties from `apps-script/README.md`, including
   `SPREADSHEET_ID`, `GOOGLE_OAUTH_CLIENT_ID`, `ALLOWED_USERS_JSON`,
   `ALLOWED_ORIGINS`, `APP_ENV`, and the internal proxy secret used by the
   Worker. Keep AI/provider keys in Script Properties only.
3. Push the current source with `clasp push`.
4. Run `setupSpreadsheet()` and `validateSpreadsheetSchema()`.
5. Deploy the Web App as execute-as-owner with access suitable for the existing
   internal-secret boundary. Copy the `/exec` URL to the Pages variable.
6. Smoke public reads, GIS rollback writes, Better Auth actor-gateway writes,
   TJ lookup/search/add/restore, and ChangeLog entries before enabling the new
   browser path.

The updated TJ adapter is a fixed-host Apps Script fetch. It is not live until
this source is pushed and the exact-number, Unicode, no-result, upstream,
throttle, and parser-drift cases are checked.

## Better Auth Worker and D1

1. Provision a Cloudflare D1 database for the Worker and bind it as `AUTH_DB`.
2. Apply `integrations/chatgpt-proxy/migrations/0001_better_auth.sql` to the
   remote database.
3. Store a strong random `BETTER_AUTH_SECRET` in Worker secrets.
4. Create a dedicated Google OAuth web client for browser sessions. Register
   the exact callback:
   `https://<auth-origin>/api/auth/callback/google`.
5. Set Worker vars `BETTER_AUTH_URL`, `AUTH_TRUSTED_ORIGINS`,
   `AUTH_SESSION_EXPIRES_IN_SECONDS=1209600`,
   `AUTH_SESSION_UPDATE_AGE_SECONDS=86400`, and leave
   `BETTER_AUTH_ENABLED=false` while testing.
6. Keep the existing ChatGPT OAuth Google client/callback and GPT secrets
   separate from the Better Auth client/secret.
7. Deploy the Worker, then test credentialed CORS, HTTP-only cookie behavior,
   reload/restart, renewal, logout, allowlist removal, and protected gateway
   admission from the actual Pages origin.
8. Set `BETTER_AUTH_ENABLED=true` only after those checks and the Pages build
   is ready.

`workers.dev` and `github.io` are different sites. The configured
`SameSite=None; Secure` cookie and exact CORS/origin list must be tested in the
supported browsers. A custom domain can reduce this cross-site risk, but it
must be chosen before registering the final Google callback and production
origin values.

## Rollback

Set `BETTER_AUTH_ENABLED=false`, rebuild Pages with GIS fallback enabled, and
leave Apps Script's legacy ID-token path available. Do not alter the separate
ChatGPT `/authorize`, `/token`, or `/api/gpt*` protocol during browser-auth
rollback.
