# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder

# better-sqlite3 may need to compile when an ARM64 prebuild is unavailable.
# Keep the native toolchain in this throw-away stage only.
RUN apt-get update \
  && apt-get install --no-install-recommends -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so dependency installation remains cacheable.
COPY package.json package-lock.json tsconfig.base.json tsconfig.node.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY integrations/chatgpt-proxy/package.json integrations/chatgpt-proxy/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server-core/package.json packages/server-core/package.json
COPY packages/songbook-mcp/package.json packages/songbook-mcp/package.json
COPY packages/songbook-admin/package.json packages/songbook-admin/package.json

RUN npm ci

# Build the workspaces in dependency order. The server workspace consumes the
# compiled shared/core/MCP/admin packages.
COPY apps/web ./apps/web
COPY apps/server ./apps/server
COPY integrations/chatgpt-proxy ./integrations/chatgpt-proxy
COPY packages/shared ./packages/shared
COPY packages/server-core ./packages/server-core
COPY packages/songbook-mcp ./packages/songbook-mcp
COPY packages/songbook-admin ./packages/songbook-admin

RUN npm run build -w @songbook/shared \
  && npm run build -w @songbook/server-core \
  && npm run build -w @songbook/mcp \
  && npm run build -w @songbook/admin \
  && npm run build -w @songbook/server \
  && npm run build -w @songbook/web \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SONGBOOK_DB=/var/lib/songbook/songbook.sqlite \
    SONGBOOK_BACKUP_DIR=/var/backups/songbook

WORKDIR /app

RUN mkdir -p /var/lib/songbook /var/backups/songbook \
  && chown -R node:node /var/lib/songbook /var/backups/songbook

COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder --chown=node:node /app/integrations/chatgpt-proxy/package.json ./integrations/chatgpt-proxy/package.json
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=node:node /app/packages/server-core/package.json ./packages/server-core/package.json
COPY --from=builder --chown=node:node /app/packages/songbook-mcp/package.json ./packages/songbook-mcp/package.json
COPY --from=builder --chown=node:node /app/packages/songbook-admin/package.json ./packages/songbook-admin/package.json

# npm workspaces link local packages from node_modules. Copy their compiled
# output and the server/web artifacts the runtime needs.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=builder --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/packages/server-core/dist ./packages/server-core/dist
COPY --from=builder --chown=node:node /app/packages/songbook-mcp/dist ./packages/songbook-mcp/dist
COPY --from=builder --chown=node:node /app/packages/songbook-admin/dist ./packages/songbook-admin/dist

USER node
EXPOSE 3000

# The application owns /healthz. Compose and an OCI supervisor use the same
# readiness contract.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
