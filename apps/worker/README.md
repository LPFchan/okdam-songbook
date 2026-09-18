# @songbook/worker

The Cloudflare Workers entry point and the only production runtime. It mounts
the Hono application from `@songbook/server` over a D1 executor and serves
the PWA from Workers Assets (`apps/web/dist`).

- `src/index.ts` — builds the app once per isolate, serves statics with an
  `index.html` fallback, attaches frame-denial headers to HTML.
- `wrangler.toml` — route-less (`workers_dev = false`, no `[[routes]]`); the
  `auth-gateway` Worker holds `okdam.lost.plus/*` and reaches this Worker
  over its `SONGBOOK_BACKEND` service binding.
- `migrations/` — D1 schema, applied with `wrangler d1 migrations apply`.
- `test/` — the entry driven against a fake D1 and a fake Assets fetcher.

## Local dev

```
npm run build          # repo root, once
cd apps/worker
npx wrangler dev       # http://localhost:8787 with local D1
npm test               # vitest
```

## Deploy, verify, roll back

See [docs/deployment.md](../../docs/deployment.md).
