# Production Ops Checklist (2026-07-01)

> Historical checklist. The current rollout sequence, including Better Auth and TJ provisioning, is [Production Rollout Checklist (2026-08-13)](ops-checklist-2026-08-13.md).

## Sheet
- ID: `1VU3ad7z19J92V18DKmqVNzfpRzCKywXKxmXoD3EscgM`
- URL: https://docs.google.com/spreadsheets/d/1VU3ad7z19J92V18DKmqVNzfpRzCKywXKxmXoD3EscgM/edit
- Title: `Okdam Songbook Data`
- Owner: `iam.marierie@gmail.com`
- Access: private

## Apps Script
- Script ID: `1Pzp6evn-Oh-hTcp6lowody9egge0k8TiChYBaWpRzKvP8IrEcWPR8yJ1`
- Editor URL: https://script.google.com/home/projects/1Pzp6evn-Oh-hTcp6lowody9egge0k8TiChYBaWpRzKvP8IrEcWPR8yJ1/edit
- Clasp config: `apps-script/.clasp.json` (local), `apps-script/src/appsscript.json` (manifest, Asia/Seoul)
- Existing API executable deployment: `AKfycbz8g-5SQaDPIIqRPs36S6jICL1L-pev139Sq38oJTHwoI8bxbk4HWp_neu5RsFlrJHf @1` (NOT the webapp /exec — see below)

## Script Properties (already set)
- `SPREADSHEET_ID=1VU3ad7z19J92V18DKmqVNzfpRzCKywXKxmXoD3EscgM`
- `GOOGLE_OAUTH_CLIENT_ID=670381524945-hh22l4m8in8rld0agoplbli2lah1t18b.apps.googleusercontent.com`
- `ALLOWED_USERS_JSON` (owner: 마리, editor: 성욱, editor: 여울)
- `ALLOWED_ORIGINS=https://devuterian.github.io`
- `APP_ENV=production`
- `ALLOW_CSV_IMPORT=true` (must be flipped to `false` after import)

> Note: `apps-script/src/TempConfig.js` is still on the server as a leftover helper from the Script-Properties setup phase. It is now in `apps-script/.claspignore`, will not be re-pushed, and is safe to delete from the Apps Script editor when convenient.

## OAuth Web Client
- Client ID: `670381524945-hh22l4m8in8rld0agoplbli2lah1t18b.apps.googleusercontent.com`
- Authorized JS origin: `https://devuterian.github.io`

## GitHub Actions Variables
- `VITE_GOOGLE_CLIENT_ID` — SET
- `VITE_APPS_SCRIPT_API_URL` — MISSING, needs `/exec` URL

## Operator-only steps (Google UI)
1. Apps Script editor → Run `setupSpreadsheet()` (authorize if asked).
2. Run `validateSpreadsheetSchema()`. Expect 3 sheets, all `ok: true`.
3. Apps Script editor → Deploy → New deployment → type "Web app", execute as `Me`, access `Anyone`. Copy `/exec` URL.
4. `gh variable set VITE_APPS_SCRIPT_API_URL --repo devuterian/okdam-songbook --body '<url>'`
5. Run `importCsvSongs` with payload `{songs: [...115...]}`. Expect `inserted: 115, skipped: 0, errors: 0` on first run.
6. Re-run `importCsvSongs` — expect `inserted: 0, skipped: 115`.
7. Flip `ALLOW_CSV_IMPORT=false` in Script Properties.
8. GitHub Actions redeploys Pages with the new `VITE_APPS_SCRIPT_API_URL`.

## Headless (clasp) imports
```sh
cd apps-script
jq '{songs: .songs}' seed/songs.json > /tmp/import.json
# clasp run --params receives a JSON array of args
npx @google/clasp run 'importCsvSongs' --params "[$(cat /tmp/import.json)]"
```

## Local smoke (terminal)
- `npm run lint && npm run typecheck && npm run test && npm run build` all pass.
- `npm run dev` → http://127.0.0.1:5182/okdam-songbook/ → expect 115 sample songs with `VITE_ENABLE_MOCK_API=true`.
- Production build with `VITE_ENABLE_MOCK_API=false` and `VITE_APPS_SCRIPT_API_URL` set → live /exec fetch.

## Live verification (browser, after deploy)
1. Visit https://devuterian.github.io/okdam-songbook/ → expect network request to `/exec?action=publicData` returning 115 songs.
2. /admin → click Google login → choose 마리 → expect role=owner.
3. Public page → pick a song → "오늘 불렀습니다" → expect POST `/exec?action=createPerformance` returning `{id}`.
4. Click the "취소" toast button → expect POST `/exec?action=cancelPerformance` returning `{cancelledAt}`.
5. Sheet's `Performances` → that row has `cancelledAt` set.

## Auth state (2026-07-01)

- Google ID token is **never** persisted. `apps/web/src/lib/auth/AuthContext.tsx`
  holds the credential in memory only and re-authenticates on every write call.
- `requireValidCredential()` is the single entry point used by `upsertSong`,
  `createPerformance`, `cancelPerformance`, `analyzeYouTube`,
  `generateReading`. If the token is missing, expired, or rejected with
  `UNAUTHORIZED` / `FORBIDDEN`, the provider drops the cached credential and
  surfaces a reauth prompt.
- The public header shows the current auth state (`마리 · owner` /
  `다시 로그인 필요` / `비로그인`) so we never imply the user is signed in
  without a fresh credential.
- The admin page mounts a single Google Identity Services button. The
  AuthProvider owns the actual credential state — there is no duplicate
  `idToken` state in the admin component.
- Live smoke now requires:
  1. Click any song → "오늘 불렀습니다" → expect snackbar with "취소".
  2. The button hits `/exec?action=createPerformance` and the Sheet's
     `Performances` sheet gets a new row.
  3. Tap "취소" → `/exec?action=cancelPerformance` returns the cancelled row.
  4. Re-tap "오늘 불렀습니다" with the tab in incognito → expect
     "기록하려면 Google 로그인이 필요해." snackbar and a navigation prompt
     to `/admin` for sign-in.
