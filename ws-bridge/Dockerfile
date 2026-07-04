# Multi-target TCP<->WebSocket bridge so a browser LDK node can reach an allowlisted set of
# Lightning peers (the default channel peer + the LSPs). Browsers can't open raw TCP; this proxies
# a (wss, via Railway TLS) WebSocket to the requested peer's TCP :9735, gated by BRIDGE_ALLOWLIST.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-package-lock
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock
COPY --from=build /app/dist ./dist
# Railway injects PORT and terminates TLS (public endpoint is wss://). Override these in Railway:
ENV BRIDGE_TARGET=45.33.65.45:9735
ENV BRIDGE_ALLOWLIST=64.23.162.51:9735,45.79.192.236:9735,45.33.65.45:9735
CMD ["node", "dist/main.js"]
