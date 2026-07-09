# `@libre/lsps1-mock-server`

A **mock mainnet LSPS1-REST provider** (Megalith / Olympus-ZEUS) for building and testing the
"get a channel from an LSP" flow — the PWA/extension `purchaseLSPS1Capacity` → poll `getLSPS1Order`
path — **offline, deterministically, with no real LSP, no money, and no docker**.

It speaks the exact bLIP-51 REST binding the SDK's `Lsps1RestClient` uses (`GET /get_info`,
`POST /create_order`, `GET /get_order?order_id=`, sat amounts as strings, no JSON-RPC envelope), so
`LibreListenerWallet.purchaseLSPS1Capacity` / `getLSPS1Order` drive it unchanged.

> This is NOT a Lightning node. It mints a **placeholder** BOLT11 and walks the order through its
> states so you can develop the UI. No channel actually opens (the wallet's peer dial to the mock's
> `uris` is best-effort and its failure is caught + warned, exactly as against a real LSP behind a
> bridge). To fund a real regtest channel, use `@libre/lsps2-server` + the docker stack instead.

## Two ways to use it

### 1. As a live local server (build the browser UI by clicking)

```bash
pnpm --filter @libre/lsps1-mock-server build
pnpm --filter @libre/lsps1-mock-server start          # → http://127.0.0.1:9098/mock-lsps1/v1
# or: node packages/libre-lsps1-mock-server/server.cjs
```

Point the app's **LSPS1 REST base URL** at the printed base (`http://127.0.0.1:9098/mock-lsps1/v1`)
and run the flow. CORS is open (`*`) so any localhost origin (Vite `:5173`, the extension) can hit it.

**Advance modes** (`MOCK_ADVANCE`):
- `manual` (default) — the order stays `awaiting_payment` until you drive it:
  ```bash
  curl -X POST "http://127.0.0.1:9098/mock-lsps1/v1/_control/pay?order_id=mock-order-1"
  curl -X POST "http://127.0.0.1:9098/mock-lsps1/v1/_control/complete?order_id=mock-order-1"
  curl -X POST "http://127.0.0.1:9098/mock-lsps1/v1/_control/fail?order_id=mock-order-1"
  curl      "http://127.0.0.1:9098/mock-lsps1/v1/_control/orders"
  ```
- `timed` — auto-walks `awaiting_payment → paid → completed` off the clock, so the app's poller shows
  progress hands-free: `MOCK_ADVANCE=timed PAID_AFTER_MS=4000 COMPLETED_AFTER_MS=8000 pnpm … start`.

**Env config:** `PORT` (9098), `BASE_PATH` (`/mock-lsps1/v1`), `MIN_CHANNEL_SAT` (150000),
`MAX_CHANNEL_SAT` (16000000), `MAX_EXPIRY_BLOCKS` (13140), `MIN_CONFS` (`0` = advertise 0-conf-capable
like Megalith; `3` = confirmed like Olympus), `FEE_BASE_SAT` (2000), `FEE_PPM` (4000),
`MOCK_ADVANCE`, `PAID_AFTER_MS`, `COMPLETED_AFTER_MS`.

### 2. As MSW handlers (deterministic vitest, no server, no docker)

```ts
import { MockLsps1Provider } from "@libre/lsps1-mock-server";
import { mockLsps1MswHandlers } from "@libre/lsps1-mock-server/msw";

const provider = new MockLsps1Provider({ nodePubkey: "038a9e56…" });
server.use(...mockLsps1MswHandlers("http://mock-lsp.test/lsps1/v1", provider));

// drive the REAL wallet flow, then step the order deterministically:
await wallet.purchaseLSPS1Capacity({ amountSats: 1_000_000, lsp });
provider.markPaid("mock-order-1");
provider.complete("mock-order-1");
```

See the worked end-to-end example in
`packages/libre-listener-wallet/src/tests/unit/lsps1-mock-flow.test.ts` (buy → poll
awaiting→paid→completed, bounds rejection, and the 0-conf-vs-3-conf request gating).

## What it faithfully reproduces vs. what it doesn't

**Does:** the LSPS1 REST wire shapes and status machine; channel bounds enforcement; opening-fee
computation; the `get_info.uris` the client dials; the 0-conf/confirmed `min_required_channel_confirmations`
signal that gates the wallet's request; order lifecycle incl. failure. `provider.lastCreateOrder`
exposes exactly what the app sent (lease blocks, confs, announce flag, client pubkey).

**Doesn't:** open a real Lightning channel, pay a real invoice, or move funds. For a real funded
channel on regtest, use `@libre/lsps2-server` + `docker compose up -d`.
