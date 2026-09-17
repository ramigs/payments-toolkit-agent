# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# payments-toolkit-mcp is a separate repo that this agent spawns as a local
# stdio child process (see src/agent.ts) rather than talking to over a
# network transport, so it has to be built into this same image. Pin the
# commit for a reproducible build; `pnpm run deploy` bumps it to main's
# latest HEAD before deploying (scripts/bump-mcp-commit.sh).
# ---------------------------------------------------------------------------
FROM node:24.18.0-slim AS mcp-builder
ARG MCP_COMMIT=0425ee443da1473e05885838a0db1208b770cb6f
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /mcp
RUN git clone https://github.com/ramigs/payments-toolkit-mcp.git . \
    && git checkout "$MCP_COMMIT"
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN pnpm prune --prod

# --- This repo's own build --------------------------------------------------
FROM node:24.18.0-slim AS agent-builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY eval ./eval
RUN pnpm run build
RUN pnpm prune --prod

# --- Runtime -----------------------------------------------------------------
# alpine here, not slim: the production node_modules copied in below (both
# repos') carry no native addons — checked via `find node_modules -name
# "*.node"`, only macOS-only devDependency build tools turned up, already
# pruned out — so the smaller, lower-CVE base is safe to use for what's
# actually deployed. The builder stages above stay on slim/glibc since they
# need apt/git and their own OS packages never ship in this final image.
FROM node:24.18.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Companion MCP server, spawned over stdio at runtime.
COPY --from=mcp-builder /mcp/dist /mcp/dist
COPY --from=mcp-builder /mcp/node_modules /mcp/node_modules
COPY --from=mcp-builder /mcp/package.json /mcp/package.json

# This service's own build output and production dependencies.
COPY --from=agent-builder /app/dist ./dist
COPY --from=agent-builder /app/node_modules ./node_modules
COPY --from=agent-builder /app/package.json ./package.json

ENV MCP_SERVER_PATH=/mcp/dist/index.js
ENV PORT=3001
EXPOSE 3001

# GEMINI_API_KEY and SUPABASE_URL are required at runtime (see src/http.ts)
# and are intentionally not set here — provide them as platform secrets.

# src/logging.ts mkdir's <cwd>/logs on import; /app is root-owned by
# default, so the unprivileged `node` user below needs it pre-created.
RUN mkdir -p /app/logs && chown node:node /app/logs

USER node
CMD ["node", "dist/src/http.js"]
