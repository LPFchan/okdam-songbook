# @songbook/worker

Cloudflare Workers entry point for the songbook app. Serves the same Hono API
and MCP surface as the Node server, backed by D1 instead of a SQLite file and
Workers Assets instead of the filesystem.

## Local dev

```
npm run build          # repo root, once
cd apps/worker
npx wrangler dev       # serves on http://localhost:8787 with local D1
```

## Deploy

See [docs/deployment.md](../../docs/deployment.md#cloudflare-workers-supported-target).
