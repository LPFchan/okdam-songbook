# DEC-20261010-001: Drop The /admin Route

Opened: 2026-10-10 12-44-55 KST
Recorded by agent: claude-code

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Supersedes: the `/admin` alias paragraph of DEC-20260813-002
- Related ids: DEC-20260813-002, DEC-20260919-001

## Decision

The SvelteKit app has one route, `/`. The `/admin` route is removed. Requests for
`/admin`, like any other unknown path, fall back to the main surface.

The rest of DEC-20260813-002 (one catalog-first surface with contextual,
server-protected management tools) stands.

## Context

DEC-20260813-002 kept `/admin` as a compatibility deep link into the same
main-page composition. On Workers the Worker serves unknown paths through the
Assets `/index.html` fallback, which answers with a redirect to `/`, so
`/admin` already landed on `/` and the route file only rendered the same
`CatalogPage`.

## Options considered

- Keep the alias and make `/admin` answer 200 at its own address.
- Remove the route and let `/admin` fall back like any other path.

## Rationale

Nothing links to `/admin` and it adds no behavior, so it is a second name for
the same page that docs and deploy checks have to keep describing.

## Consequences

- `apps/web/src/routes/admin` is deleted.
- Post-deploy checks probe `/` instead of `/admin`.
- Old `/admin` bookmarks still open the app.
