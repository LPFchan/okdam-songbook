# API

## Public routes

Reached through the gateway's `public` policy, with no identity headers:

- `GET /api/catalog` — the anonymous catalog envelope `{ ok, data: { songs,
  serverVersion, updatedAt }, error, requestId, serverTime }` with an `ETag`;
  `If-None-Match` answers 304. No email or favorite fields.
- `GET /healthz` — `{"ok":true}` when D1 answers.
- Everything else that is not `/api`, `/mcp` or `/.well-known` is the PWA
  from Workers Assets, with `index.html` as the SPA fallback.

Errors use `{ ok: false, data: null, error: { code, message, details } }`
with the HTTP status mapped from `code` (400 validation, 401, 403, 404, 409
conflict/duplicate, 429 rate limited, 502 upstream, 503 AI not configured).

## Shared-auth browser routes

The live browser path uses the `.lost.plus` shared session:

- `GET /api/session` — returns the active HTTP-only-cookie session and the
  current common-auth user with role `allowed`.
- `GET /api/me` — returns the current common-auth user.
- `GET /_auth/logout` — gateway-owned shared browser logout.
- `POST /api/songs`, `PATCH /api/songs/:id`, and
  `DELETE /api/songs/:id/delete` — protected song mutations.
- `POST /api/performances` and `DELETE /api/performances/:id` — protected
  performance mutations.
- `POST /api/readings/generate` — protected Korean-reading candidate
  generation for a bounded title/artist pair.

Browser calls use `credentials: include`, exact same-origin mutation checks,
and JSON request bodies. There is no browser-readable bearer token in this
transport. Every protected route requires an authenticated session whose
Common Auth service list is empty or includes `okdam`; all admitted users share
the same mutation permissions, including song deletion.

## MCP

The stateless MCP mount at `/mcp` requires OAuth or a valid shared machine
bearer on every request. `catalog`, `search_songs`, and `get_song` require the
internal `songbook:read` capability.
`record_performance`,
`cancel_performance`, `create_song`, `update_song`, and `delete_song` require
a bearer minted at `auth.lost.plus` for `okdam-mcp`. Every admitted bearer receives the
internal `songbook:read` and `songbook:write` capabilities.

`search_songs` always returns `{ query, saved, tj }`. It uses the website’s
trimmed query gate: TJ is eligible for queries with at least two characters or
all-digit queries, and all-digit queries use number search. `includeTj=false`
reports `disabled_by_input`. A bearer call needs `songbook:read` before it can continue
to TJ. TJ failures return a successful tool result with local matches intact
and safe error metadata.

`create_song` accepts the compact song-create fields or a validated
`tjCandidate` and returns a structured `created`, `duplicate`, or `deleted`
outcome. `update_song` and `delete_song` accept `id` or their corresponding
`songId` alias, plus `expectedVersion` and `clientRequestId`.

MCP cookies are not identity. Missing gateway identity and malformed or invalid
credentials are rejected before backend dispatch. Client-supplied method/name
headers are never authorization input.

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
URL. Deleted matches return `canRestore: false`; the current API exposes no
restore route.

## Song data

`Song.performerIds` is an array of user IDs. The server accepts only `marie`,
`seongwook`, and `yeowool`, deduplicates them, and writes them to
`performer_ids_json` in D1. `Song.recommendedKey` is either null or one
`{ baseMode, offset }` value. Original-work context is plain memo text prefixed
with `원작:`; aliases, romanization, YouTube metadata, and song status are not
part of the live song contract.

POST bodies are JSON sent as `text/plain;charset=utf-8` on the legacy Apps
Script transport. The live browser gateway uses JSON and
`Content-Type: application/json`.

## Separate ChatGPT Action API

`/authorize`, `/oauth/callback`, `/token`, and `/api/gptSearchSongs`,
`/api/gptCheckDuplicate`, `/api/gptAddSong` remain the separate ChatGPT OAuth
contract. Shared browser sessions do not change those retired routes.
