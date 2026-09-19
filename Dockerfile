# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# payments-toolkit-mcp is deployed as its own separate Railway service now,
# reached over HTTP (see src/agent.ts's MCP_SERVER_URL/MCP_AUTH_TOKEN) rather
# than spawned as a local stdio child process — see that repo's own
# Dockerfile for its build. Nothing from it is built into this image.
# ---------------------------------------------------------------------------

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
# alpine here, not slim: this repo's own production node_modules carry no
# native addons — checked via `find node_modules -name "*.node"`, only
# macOS-only devDependency build tools turned up, already pruned out — so the
# smaller, lower-CVE base is safe to use for what's actually deployed. The
# builder stage above stays on slim/glibc since it needs its own OS packages,
# which never ship in this final image.
FROM node:24.18.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# This service's own build output and production dependencies.
COPY --from=agent-builder /app/dist ./dist
COPY --from=agent-builder /app/node_modules ./node_modules
COPY --from=agent-builder /app/package.json ./package.json

ENV PORT=3001
EXPOSE 3001

# GEMINI_API_KEY, SUPABASE_URL, MCP_SERVER_URL, and MCP_AUTH_TOKEN are
# required at runtime (see src/http.ts, src/agent.ts) and are intentionally
# not set here — provide them as platform secrets. MCP_SERVER_URL points at
# the payments-toolkit-mcp Railway service's private network address (e.g.
# http://payments-toolkit-mcp.railway.internal:3000/mcp), not a public URL.

USER node
CMD ["node", "dist/src/http.js"]
