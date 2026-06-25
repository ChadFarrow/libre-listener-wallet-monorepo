# Libre Listener Wallet Production Deployment Guide

This document provides a comprehensive, step-by-step guide for developers to deploy the **Libre Listener Wallet** system (SDK client, LSP registry, WebSocket bridge, and NWC push gateway) to a production/mainnet environment.

---

## Architecture Blueprint

In production, the architecture relies on secure client-side execution, a curated LSP directory, chain/routing sync utilities, and a stateless gateway for background push notification relaying:

```
                            +---------------------------------------+
                            |       Client Browser / Mobile App     |
                            |    (LDK WASM runs in browser sandbox) |
                            +---------------------------------------+
                                                |
          +------------------+-----------------+---------------+-------------------+-------------------+
          | (HTTPS GET)      | (Secure WSS)    | (HTTPS JSON)  | (HTTPS JSON)      | (HTTPS RGS)       | (HTTPS WebPush)
          v                  v                 v               v                   v                   v
   +---------------+  +---------------+ +-----------+  +---------------+  +---------------+  +---------------+
   | Curated LSP   |  | TCP/WS Proxy  | |    LSP    |  |  Esplora API  |  |  LDK Rapidsync|  | Libre NWC Gate|
   | Registry JSON |  |  (Web Bridge) | | (LSPS1/2) |  | (Mempool API) |  | (Gossip Sync) |  | (Push Relays) |
   +---------------+  +---------------+ +-----------+  +---------------+  +---------------+  +---------------+
     [Static CDN]      [Docker Server]   [Commercial     [Third-Party or     [LDK Public or     [Docker/Node.js
     (Cloudflare)      (Render/ECS)      or Custom]       Self-Hosted]        Self-Hosted]       on Cloud VM]
```

---

## 1. Build and Bundle Strategy

The codebase is structured as a TypeScript monorepo managed by `pnpm` and Turborepo.

To compile all the workspace packages for production:
```bash
# Install all root and sub-workspace dependencies
pnpm install

# Compile shared, SDK, and gateway packages to their dist/ folders
pnpm build
```

This compiles:
*   `@libre/shared` to CommonJS / ESM.
*   `@libre/listener-wallet` to distribution files with IndexedDB state persistence logic.
*   `@libre/nwc-push-gateway` to CJS distribution files.

---

## 2. Deploying the Static Client (PWA/Frontend App)

The wallet SDK (`@libre/listener-wallet`) executes entirely inside the browser's sandbox using WebAssembly.

### Static Asset Deployment
Deploy your frontend app (Vite, Next.js, Nuxt, etc.) that imports the SDK to a global CDN:
*   **Hosting Providers**: Vercel, Netlify, Cloudflare Pages, AWS S3 + CloudFront.
*   **Security Requirement**: **HTTPS is mandatory**. Browsers will block IndexedDB, Service Workers, and Web Crypto APIs on non-secure connections (except localhost).

### Configuring the Service Worker
To handle background Nostr Wallet Connect (NWC) requests when the app is closed, configure a PWA Service Worker (e.g., `sw.js`):
1.  **Cache the WASM Files**: Ensure the Service Worker caches the LDK WASM assets so it can boot instantly offline.
2.  **Web Push Listener**: Implement the `push` event handler in the Service Worker:
    ```javascript
    self.addEventListener('push', function(event) {
      const data = event.data.json();
      event.waitUntil(
        // Boot LDK WASM silently, process NWC request from Nostr relay, and reply
        bootLdkAndProcessNwc(data.walletPubkey, data.relayUrl, data.eventId)
      );
    });
    ```
3.  **Bootstrap Constraint**: Web push wakeups must execute and resolve within **15 seconds** (browser Service Worker lifetime limit). Ensure block syncing on startup is incremental.

---

## 3. Host the Curated LSP Registry (`.well-known`)

To prevent users from connecting to malicious nodes that might execute double-spend attacks on zero-conf channels, the SDK fetches a list of trusted LSPs on startup.

1.  **JSON Payload**: Create a static JSON configuration file at `public/.well-known/lightning-providers.json`:
    ```json
    {
      "providers": [
        {
          "name": "Olympus LSP",
          "pubkey": "03a503da93d35091a1...",
          "api_url": "https://olympus.breez.technology",
          "connection_address": "node.olympus.lsp:9735",
          "websocket_proxy_url": "wss://ws-bridge.yourdomain.com",
          "supported_protocols": ["LSPS1", "LSPS2"]
        }
      ]
    }
    ```
2.  **Hosting & Caching**: 
    *   Deploy this file under the main domain of your host application (e.g. `https://v4vmusic.com/.well-known/lightning-providers.json`).
    *   Set appropriate HTTP cache headers (e.g. `Cache-Control: public, max-age=3600`) and serve via a CDN to guarantee high availability.

---

## 4. Lightning Service Provider (LSP) Setup

New users begin with `0 sats` and cannot pay on-chain mining fees to open their first channel. The wallet uses **LSPS2 JIT Channels** to bypass this onboarding hurdle.

### Option A: Partnering with Commercial LSPs (Outsourced)
Partner with existing commercial LSPs (e.g., Breez, Olympus, Blocktank, Voltage):
1.  Establish commercial terms (they collect JIT channel fees from your users' inbound payments).
2.  Obtain their public node details, API endpoints, and zero-conf policies.
3.  Add their parameters directly to your `.well-known/lightning-providers.json` registry.
4.  **Zero Capital**: No BTC liquidity is locked up by your platform; the third-party LSP manages funding inputs.

### Option B: Self-Hosting a Custom LSP Node
To collect routing/setup fees and maintain complete sovereign control:
1.  **Run a Lightning Daemon**: Deploy Core Lightning (CLN) or LND on a secure cloud server (e.g., AWS EC2, DigitalOcean Droplet).
2.  **Install LSPS Plugins**:
    *   For Core Lightning, install the [cln-plugins (LSPS1/LSPS2)](https://github.com/Blockstream/cln-plugins).
3.  **Enable Protocols**:
    *   Configure LND/CLN to support **zero-conf (0-conf)** channels.
    *   Enable **SCID Alias** (Short Channel ID alias) to protect user channel privacy.
4.  **Capital Requirements**:
    *   Fund the LSP node on-chain wallet with several Bitcoins of liquidity.
    *   Ensure the node keeps a liquid pool of UTXOs to instantly respond to incoming JIT channel openings.

---

## 5. TCP-to-WebSocket Proxy (Web Bridge)

Lightning Network nodes speak raw TCP over port `9735`. Web browsers cannot establish raw TCP connections. They must communicate over WebSockets.

If your chosen LSP does not expose a WebSocket port directly, you must host a WebSocket-to-TCP proxy.

### Dockerized Deployment (using Websockify)
Deploy a lightweight Web Bridge service:
1.  **Docker Command**:
    ```bash
    docker run -d --name websockify -p 8081:8081 python:3-slim sh -c "pip install websockify && websockify 0.0.0.0:8081 <LSP_TCP_IP>:9735"
    ```
2.  **Nginx Reverse Proxy & TLS Configuration**:
    Configure Nginx on your bridge server to handle SSL termination, turning `ws://` into `wss://` for secure browser transport:
    ```nginx
    server {
        listen 443 ssl;
        server_name ws-bridge.yourdomain.com;

        ssl_certificate /etc/letsencrypt/live/ws-bridge.yourdomain.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/ws-bridge.yourdomain.com/privkey.pem;

        location / {
            proxy_pass http://127.0.0.1:8081;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "Upgrade";
            proxy_set_header Host $host;
            proxy_read_timeout 86400;
        }
    }
    ```

---

## 6. Chain Sync & Gossip Sync Infrastructure

To function, LDK needs blockchain sync (Esplora) and routing pathfinders (Rapid Gossip Sync).

### Chain Sync (Esplora API)
The client SDK must be configured with a mainnet Esplora URL:
*   **Third-Party (Free/Public)**: Configure the SDK with `https://mempool.space/api` or `https://blockstream.info/api`.
*   **Self-Hosted (Sovereign)**: Deploy `bitcoind` + `electrs` / `Esplora` in your cluster. This ensures your users' transactional metadata and wallet addresses are never leaked to public explorers.

### Rapid Gossip Sync (RGS)
Do not download the entire Lightning network graph directly on browser clients (takes minutes and heavy network load).
*   Point the SDK config's RGS parameter to the public server run by the LDK developers:
    `https://rapidsync.lightningdevkit.org/`
*   This delivers compressed gossip snapshots in seconds, preserving client battery and bandwidth.

---

## 7. Deploying the Libre NWC Push Gateway

The `libre-nwc-push-gateway` is a stateless Node.js application that listens to Nostr relays and routes notifications to offline clients.

### 1. Write the Server Entry Point
Create a simple runner script (e.g. `server.js`) inside your deployment environment:
```javascript
const { LibreNWCPushGateway } = require("./dist/index.js");

const port = process.env.PORT || 3001;
const host = process.env.HOST || "0.0.0.0";
const dbPath = process.env.DATABASE_PATH || "push-gateway.db";
const defaultRelayUrl = process.env.DEFAULT_RELAY_URL || "wss://relay.damus.io";

const gateway = new LibreNWCPushGateway({
  host,
  port,
  dbPath,
  relayUrl: defaultRelayUrl
});

gateway.start()
  .then(() => console.log(`[Gateway] Push Gateway active on port ${port}`))
  .catch((err) => {
    console.error("[Gateway] Boot failed:", err);
    process.exit(1);
  });
```

### 2. Deploy via Docker
Create a `Dockerfile` for the gateway:
```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY . .
RUN pnpm install
RUN pnpm build

FROM node:20-slim
WORKDIR /app
RUN npm install -g pnpm
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
RUN pnpm install --prod
EXPOSE 3001
ENV PORT=3001
ENV HOST=0.0.0.0
CMD ["node", "dist/server.js"]
```

### 3. Production Environment Variables
When running the container, configure these variables:
*   `PORT`: Port the Express server binds to (e.g., `3001`).
*   `HOST`: `0.0.0.0` to allow external network requests.
*   `DATABASE_PATH`: Absolute path to persistent volume storage for SQLite (e.g. `/data/push-gateway.db`). Ensure the directory `/data` is backed by a persistent storage volume so user subscriptions survive redeployments.
*   `DEFAULT_RELAY_URL`: The default Nostr relay to boot-strap (e.g. `wss://relay.damus.io`).

### 4. VAPID Keys Configuration
On its first boot, the gateway will auto-generate Web Push VAPID keys and save them to the `vapid_keys` table in `push-gateway.db`.
*   Ensure the SQLite file is persisted across app restarts to prevent regenerating keys. If keys are regenerated, all registered browser subscriptions become invalid and users will stop receiving offline wakeups until they re-register.
*   Ensure the REST endpoint `/api/vapid-public-key` is exposed to the frontend app, enabling it to register push subscriptions correctly.

---

## Deployment Checklist

- [ ] **HTTPS Enforced**: Front-end CDN has SSL active.
- [ ] **WS-to-TCP Proxy**: Secure `wss://` proxy configured for WebSockets.
- [ ] **Registry Hosted**: Trusted `.well-known/lightning-providers.json` served with CDN caching.
- [ ] **LSP Configured**: Valid LSPS2/LSPS1 credentials configured in the registry.
- [ ] **Push Gateway Persistent**: Push gateway DB path mapped to persistent volume.
- [ ] **Network Mode**: Client SDK initialized on network `'bitcoin'` (mainnet).
- [ ] **RGS Sync active**: Rapidsync client pointed to `https://rapidsync.lightningdevkit.org/`.
