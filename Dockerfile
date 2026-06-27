# NWC Push Gateway — Railway/Docker image.
# Builds the pnpm workspace and runs only the gateway service.
FROM node:22-bookworm-slim

# Build toolchain for the native better-sqlite3 dependency (node-gyp).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.10.0
WORKDIR /app

# Copy manifests first so `pnpm install` is cached when only source changes.
# All workspace package.json files are needed for pnpm to resolve the workspace graph.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/libre-nwc-push-gateway/package.json packages/libre-nwc-push-gateway/
COPY packages/libre-listener-wallet/package.json packages/libre-listener-wallet/
COPY packages/example-app/package.json packages/example-app/
RUN pnpm install --frozen-lockfile

# Copy the rest of the repo and build the gateway (turbo builds @libre/shared first).
COPY . .
RUN pnpm exec turbo run build --filter=@libre/nwc-push-gateway

ENV HOST=0.0.0.0
ENV PORT=3001
# Persist SQLite to a Railway volume mounted at /data (VAPID keys + push subscriptions).
ENV DATABASE_PATH=/data/push-gateway.db
EXPOSE 3001

CMD ["node", "packages/libre-nwc-push-gateway/server.cjs"]
