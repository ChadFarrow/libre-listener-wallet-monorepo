# `@libre/lsps2-server`

Minimal **regtest** LSP for the Libre Listener Wallet. Implements the LSPS2 JSON-RPC
the app speaks and, on `lsps2.buy`, opens a non-anchor channel from `libre-lnd` to
the listener with pushed sats — funding the wallet via the app's **Request Invoice**
button. Dev/regtest only; not production JIT.

## Setup (regtest)

1. Start the stack: `docker compose up -d` (from repo root).
2. Extract lnd's admin macaroon + TLS cert (paths discovered from the container):
   ```bash
   MAC=$(docker exec libre-lnd sh -c 'find /root /data -name admin.macaroon 2>/dev/null | head -1')
   docker exec libre-lnd cat "$MAC" | xxd -p -c 100000 > /tmp/libre-lnd-admin.macaroon.hex
   ```
3. Run the server:
   ```bash
   LND_MACAROON_HEX=$(cat /tmp/libre-lnd-admin.macaroon.hex) \
   pnpm --filter @libre/lsps2-server build && pnpm --filter @libre/lsps2-server start
   ```
   (Dev entry sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for lnd's self-signed cert — localhost/regtest only.)

## Config (env)

`PORT` (9099), `LND_REST_URL` (https://127.0.0.1:8088), `LND_MACAROON_HEX` or `LND_MACAROON_PATH`,
`BITCOIND_RPC_URL` (http://127.0.0.1:18443), `BITCOIND_RPC_USER`/`PASS` (libre/listener),
`CHANNEL_CAPACITY_SAT` (1000000), `PUSH_SAT` (200000), `CONFIRM_BLOCKS` (3).

## Fund the wallet

In the app (regtest): Start node → Connect Peer → ensure **LSP API URL** = `http://127.0.0.1:9099/lsps2` → **Request Invoice**. A channel opens with ~200k spendable.
