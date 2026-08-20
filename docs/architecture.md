# Architecture

Songbook is a mobile-first PWA served by one Node/Hono application on OCI. The
catalog remains public; protected browser writes use Better Auth sessions and
the same SQLite database owns application state.

```mermaid
flowchart LR
  Browser[PWA] --> IndexedDB[(Public snapshot + offline queue)]
  Browser --> Node[Node/Hono server]
  MCP[Stateless MCP clients] --> Node
  Node --> SQLite[(SQLite operational DB)]
  Node --> TJ[TJ public HTML, fixed host, bounded fetch]
  Node --> Mirror[(TJ SQLite mirror)]
  Node --> Google[Better Auth Google OAuth]
```

## Frontend

- React, TypeScript, Vite, and React Router.
- `BrowserRouter` uses `/okdam-songbook/` basename.
- `PublicPage` is the catalog-first primary surface. It owns search, quick
  filters, account/session state, theme, sync details, and contextual entry to
  role-aware management sheets.
- `AdminPage` is embedded for add, manage, and history surfaces. `/admin` is a
  compatibility route to the same `PublicPage` composition.
- `vite-plugin-pwa` generates the service worker and manifest.
- Dexie stores public snapshots and offline performance queue items. Protected
  auth/session responses and credentials must not enter those caches.

## Node application

- One Node/Hono process serves the PWA, same-origin API, Better Auth routes,
  health endpoint, and stateless MCP endpoint.
- SQLite is the operational source of truth for songs, performances, audit and
  idempotency state, Better Auth state, MCP token resources, and the TJ mirror.
- The retired Apps Script/Sheets implementation remains historical migration
  material only; it is not on the live request path.

## Live TJ adapter

- Browser requests only typed lookup/search/add/restore actions.
- The Node adapter builds a fixed `tjmedia.com/song/accompaniment_search` URL,
  fetches server-rendered HTML, parses result rows, strips markup/entities,
  bounds pagination and result size, and throttles upstream fetches.
- Exact canonical queries are mirrored in SQLite for 24 hours. A stale request
  waits for refresh; successful rows update the normalized song index and
  ordered query membership. A failed refresh serves the older snapshot when
  available and records operational failure metadata.
- Parser drift, upstream failure, empty results, and rate limiting are
  structured errors. Manual entry remains available.
- Candidate source URLs come from the serving query snapshot. Immediate add
  uses duplicate checks and `clientRequestId` replay safety.

## Legacy Apps Script and Worker code

The former Apps Script/Sheets API and Cloudflare Worker integration are
retained as legacy source and migration context. They are not live request
boundaries after the OCI cutover.

## Separate ChatGPT OAuth

The Worker’s `/authorize`, `/oauth/callback`, `/token`, and `/api/gpt*` routes
remain a separate OAuth protocol for ChatGPT Actions. Better Auth browser
sessions do not replace its redirect allowlist, bearer token, or GPT action
contracts.
