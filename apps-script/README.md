# Songbook Apps Script

## Setup

1. Create a private Google Sheet.
2. Create an Apps Script project attached to that Sheet or standalone.
3. Copy `.clasp.json.example` to `.clasp.json` and set the real script id.
4. Set Script Properties:
   - `SPREADSHEET_ID`
   - `GOOGLE_OAUTH_CLIENT_ID`
   - `ALLOWED_USERS_JSON`
   - `ALLOWED_ORIGINS`
   - `APP_ENV`
   - `INTERNAL_PROXY_SECRET` when the Worker gateway is enabled
   - optional: `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `YOUTUBE_API_KEY`
5. Push with `clasp push`.
6. Run `setupSpreadsheet()` once from the Apps Script editor.
7. Deploy as Web App. Use "execute as me" and allow anyone with the deployment URL, because write authorization is enforced inside the script with Google ID tokens.

The legacy GIS `idToken` path remains available during migration. The Worker
Better Auth path sends an internal-secret request with a derived actor; Apps
Script independently resolves that actor's email and role from
`ALLOWED_USERS_JSON`. Never trust browser-supplied actor, email, or role fields.

The current source also includes `lookupTjSong`, `searchTjSongs`, `addTjSong`,
and `restoreSong`. Push and deploy those actions before enabling TJ controls in
the production Pages build, then smoke exact lookup, Unicode search,
no-result/upstream/parser-drift fallbacks, duplicate outcomes, and ChangeLog.

`ALLOWED_USERS_JSON` example:

```json
{
  "owner@example.com": { "displayName": "마리", "role": "owner" },
  "editor1@example.com": { "displayName": "성욱", "role": "editor" },
  "editor2@example.com": { "displayName": "여울", "role": "editor" }
}
```

Do not commit real emails or secrets.

## Bulk import from the OK DAM personal page

The repository ships a generated Apps Script payload at
`apps-script/seed/songs.json` produced by `scripts/import-csv.mjs`. After
deploying the Apps Script, run `setupSpreadsheet()` once and then call
`importCsvSongs` from the editor or via `clasp`:

```sh
# Push the latest Apps Script source.
npx clasp push

# Create a payload file that wraps the generated songs array.
jq '{ songs: .songs }' apps-script/seed/songs.json > /tmp/import-csv.json

# Run the import against the deployed script. Production requires
# ALLOW_CSV_IMPORT=true in Script Properties.
npx clasp run importCsvSongs --payload /tmp/import-csv.json
```

The function is idempotent: it deduplicates by TJ number and by
`(title, artist)`, skips rows that collide with existing data, and appends
only the surviving rows to the `Songs` sheet. See
`apps-script/seed/import-report.json` for the human-readable summary of what
`scripts/import-csv.mjs` produced from the source CSV.

## Migrate legacy recommenders to performers

`setupSpreadsheet()` safely appends the `performerIdsJson` column without
deleting existing rows. For a Sheet that already contains legacy recommender
data, run the migration as a dry-run first:

```sh
npx clasp push
npx clasp run migrateRecommendersToPerformers --params '[{"dryRun":true}]'
npx clasp run migrateRecommendersToPerformers --params '[{"dryRun":false}]'
```

The migration is idempotent. It reads legacy `추천인`, `recommender`,
`recommendedBy`, `createdByName`, `sourceReference`, and generated recommender
memo text, writes `performerIdsJson`, removes only generated recommender memo
phrases, and keeps ordinary memo text intact.
