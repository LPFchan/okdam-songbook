# API

## Apps Script response

Apps Script uses one action-routed endpoint:

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "requestId": "uuid",
  "serverTime": "2026-08-13T00:00:00.000Z"
}
```

Errors keep the same shape with `ok: false` and `error.code`.

## Public action

- `GET action=publicData`

This returns the public song catalog and performance summary. It does not
require login.

## Legacy GIS actions

These POST actions accept the existing `idToken` body field while the rollback
path remains enabled:

- `currentUser`
- `createPerformance`
- `cancelPerformance`
- `upsertSong`
- `generateReading`
- `analyzeYouTube`
- `lookupTjSong`
- `searchTjSongs`
- `addTjSong`
- `restoreSong`

Requests are authenticated and permission-checked by Apps Script. The browser
must not supply an actor email or role as authority.

## Better Auth browser routes

The live Better Auth browser path is served by the OCI application:

- `GET|POST /api/auth/*` — Better Auth Google OAuth/session handler.
- `GET /api/session` — returns the active HTTP-only-cookie session and the
  current allowlisted user with role `allowed`.
- `GET /api/me` — returns the current allowlisted user.
- `POST /api/songs`, `PATCH /api/songs/:id`, and
  `DELETE /api/songs/:id/delete` — protected song mutations.
- `POST /api/performances` and `DELETE /api/performances/:id` — protected
  performance mutations.

Browser calls use `credentials: include`, exact same-origin mutation checks,
and JSON request bodies. There is no browser-readable bearer token in this
transport. Every protected route requires an authenticated allowlisted
session; all allowlisted users share the same mutation permissions, including
song deletion.

## TJ contracts

`lookupTjSong` accepts a 1–8 digit `tjNumber`, optional nation, and bounded page
size. It returns an exact candidate or a bounded candidate list.

`searchTjSongs` accepts a 1–120 character query, one of `all`, `title`,
`artist`, `lyricist`, `composer`, `number`, or `medley`, optional nation, pages
1–10, and page size 1–30. It returns normalized candidates, `hasMore`, and the
fixed TJ source URL.

`addTjSong` accepts a normalized candidate and `clientRequestId`. It returns
`created`, `duplicate`, or `deleted` outcomes without overwriting an existing
row. Successful rows use `sourceType=tjmedia` and retain the bounded source
URL. Deleted matches return `canRestore: false`; the current OCI API exposes no
restore route.

## Song data

`Song.performerIds` is an array of user IDs. The server accepts only `marie`,
`seongwook`, and `yeowool`, deduplicates them, and writes them to
`performerIdsJson` in the `Songs` sheet.

POST bodies are JSON sent as `text/plain;charset=utf-8` on the legacy Apps
Script transport. Better Auth browser gateway bodies use JSON and
`Content-Type: application/json`.

## Separate ChatGPT Action API

`/authorize`, `/oauth/callback`, `/token`, and `/api/gptSearchSongs`,
`/api/gptCheckDuplicate`, `/api/gptAddSong` remain the separate ChatGPT OAuth
contract. Better Auth browser sessions do not change those routes.
