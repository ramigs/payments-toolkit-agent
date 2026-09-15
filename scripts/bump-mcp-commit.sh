#!/usr/bin/env bash
# Updates the Dockerfile's MCP_COMMIT build arg to payments-toolkit-mcp's
# current main HEAD. Run via `pnpm run deploy`, before the image is built,
# so a deploy always picks up the latest MCP server; the pinned SHA keeps
# the build reproducible in between deploys.
set -euo pipefail

REPO_URL="https://github.com/ramigs/payments-toolkit-mcp.git"
DOCKERFILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/Dockerfile"

latest=$(git ls-remote "$REPO_URL" refs/heads/main | cut -f1)
if [[ -z "$latest" ]]; then
  echo "Could not resolve main's HEAD on $REPO_URL" >&2
  exit 1
fi

current=$(grep -oE '^ARG MCP_COMMIT=[0-9a-f]+' "$DOCKERFILE" | cut -d= -f2)
if [[ -z "$current" ]]; then
  echo "Could not find 'ARG MCP_COMMIT=<sha>' in $DOCKERFILE" >&2
  exit 1
fi

if [[ "$current" == "$latest" ]]; then
  echo "MCP_COMMIT already up to date ($current)"
  exit 0
fi

tmp=$(mktemp)
sed "s/^ARG MCP_COMMIT=.*/ARG MCP_COMMIT=$latest/" "$DOCKERFILE" > "$tmp"
mv "$tmp" "$DOCKERFILE"

echo "MCP_COMMIT: $current -> $latest"
