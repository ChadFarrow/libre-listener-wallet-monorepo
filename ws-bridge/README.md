# ws-bridge — remote TCP→WebSocket bridge (Railway)

Browsers can't open raw TCP, so the browser LDK node reaches its Lightning peer over a
WebSocket that a `websockify` proxy relays to the peer's TCP `:9735`. Running it on Railway
gives the **`wss://` (TLS)** endpoint a deployed `https://` PWA requires — a deployed app
**cannot** use `ws://` (mixed-content block).

**Chain:** browser → `wss://<svc>.up.railway.app` → (Railway TLS → ws) → `websockify` →
`BRIDGE_TARGET` (`45.33.65.45:9735`, the clearnet Tor-proxy fronting the onion LND).

## Deploy

From the repo root, in its **own** Railway project/service (kept separate from the gateway):

```bash
railway up -s ws-bridge        # uses ws-bridge/railway.json (Dockerfile build)
```

Set the target if it ever changes (Railway → service → Variables):

```
BRIDGE_TARGET=45.33.65.45:9735
```

Railway injects `PORT` and terminates TLS, so the public endpoint is `wss://<svc>.up.railway.app`.

## Wire the app to it

In `packages/example-app/.env.local` (and the static host's build env):

```
VITE_MAINNET_BRIDGE=wss://<svc>.up.railway.app
```

Then rebuild/redeploy the PWA. The wallet dials this instead of `ws://127.0.0.1:8085`.

## Notes

- The target `:9735` is a Lightning P2P port (already meant to be public), so no extra auth —
  `websockify` only proxies to that one fixed `host:port`.
- Tor adds latency to the peer link; the wallet's NWC `payment_sent` notifications cover any
  late settlement.
- If Railway's healthcheck rejects the service, leave the healthcheck path unset (websockify
  isn't a plain HTTP server) — the TCP/WS endpoint still serves.
