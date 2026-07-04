# ws-bridge — multi-target TCP↔WebSocket bridge (Railway)

Browsers can't open raw TCP, so the browser LDK node reaches Lightning peers over a
WebSocket that this Node proxy relays to the peer's TCP `:9735`. The bridge gates peers
by an allowlist (`BRIDGE_ALLOWLIST`) covering three LSP/channel-peer endpoints, with a fallback
default (`BRIDGE_TARGET`). Running it on Railway gives the **`wss://` (TLS)** endpoint a deployed
`https://` PWA requires — a deployed app **cannot** use `ws://` (mixed-content block).

**Chain:** browser → `wss://<svc>.up.railway.app/?target=<allowlisted-peer>` → (Railway TLS → ws) →
Node bridge → `<peer>:9735` (TCP).

## Deploy (Railway, its own service)

```bash
railway up -s ws-bridge
```

Set in Railway → service → Variables:

```
BRIDGE_ALLOWLIST=64.23.162.51:9735,45.79.192.236:9735,45.33.65.45:9735
BRIDGE_TARGET=45.33.65.45:9735
```

Megalith = `64.23.162.51:9735`, Olympus (ZEUS) = `45.79.192.236:9735`, default peer = `45.33.65.45:9735`.
The LSP IPs come from each LSP's live `lsps1 get_info` `uris` — update the allowlist if they change.
The public endpoint (`wss://<svc>.up.railway.app`) and the app's `VITE_MAINNET_BRIDGE` are unchanged.

## Wire the app to it

In `packages/example-app/.env.local` (and the static host's build env):

```
VITE_MAINNET_BRIDGE=wss://<svc>.up.railway.app
```

The wallet auto-appends `?target=<default-peer>` and respects client overrides in the UI (custom peer field).
Then rebuild/redeploy the PWA. The wallet dials this instead of `ws://127.0.0.1:8085`.

## Custom peer

If the default peer or LSPs change, either:

1. Update `BRIDGE_ALLOWLIST` on Railway and redeploy the bridge.
2. Run your own bridge (same Dockerfile) with your own LSP set and point the app's `VITE_MAINNET_BRIDGE` to it.
