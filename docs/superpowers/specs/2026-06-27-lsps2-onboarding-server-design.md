# LSPS2 Onboarding Server (regtest dev LSP) — Design

- **Date:** 2026-06-27
- **Status:** Approved (pending spec review)
- **Scope:** New package `@libre/lsps2-server` — a minimal regtest LSP that funds the listener wallet via the app's existing LSPS2 flow.

## 1. Background / Why

The wallet's intended funding path is LSPS2 JIT: the app's **Request Invoice** button calls an LSPS2 HTTP server (`lsps2.get_versions` / `get_info` / `buy`), then builds a BOLT11 with a route hint via the LSP. But **no LSPS2 server exists** in the dev stack — the integration test MSW-mocks it and pre-opens the channel manually. So in the live app, Request Invoice has nothing to talk to, and the wallet can't be funded through its own UI. This server fills that gap for **regtest**, making funding a one-click, self-contained flow so the wallet can be tested end-to-end (fund → send keysend → receive). True HTLC-interception JIT and mainnet are explicitly out of scope (later milestone).

A second motivation: opening a channel to the browser node on regtest hits an anchor-vs-fee mismatch (lnd's 2500 sat/kw anchor commitment feerate vs LDK's ~12480 derived from electrs's flat 49.92 sat/vB). This server sidesteps it by opening a **non-anchor** channel.

## 2. Goals / Non-Goals

**Goals**
- One-click funding from the app's existing Request Invoice button on regtest (no app code changes; point `lsp-api-url` at this server).
- Implement the exact LSPS2 JSON-RPC the SDK already speaks.
- Open a real channel from `libre-lnd` to the listener with pushed sats (immediate spendable balance + inbound capacity).
- Reliable on regtest despite the fee artifact.

**Non-Goals**
- Real HTLC-interception JIT (channel opens on `buy`, not on payment; the BOLT11 the app shows is cosmetic for this dev version).
- Mainnet / production LSP, LSPS1, fee collection (dev LSP gifts sats).
- Any change to the SDK or example-app code (config-only: `lsp-api-url`).

## 3. Component & Placement

New workspace package **`packages/libre-lsps2-server`** (`@libre/lsps2-server`), an Express service modeled on `@libre/nwc-push-gateway` (CJS build via tsup, `pnpm --filter @libre/lsps2-server dev`). Listens on **`http://127.0.0.1:9099`**, serving the JSON-RPC at **`POST /lsps2`** (matches the app's default `lsp-api-url = http://127.0.0.1:9099/lsps2`).

**Modules (one responsibility each):**
- `src/index.ts` — `LibreLsps2Server` class: wires config + Express app; `start()`/`stop()`.
- `src/jsonrpc.ts` — pure request router: maps `{id, method, params}` → result/error for `get_versions`/`get_info`/`buy`. Depends on an injected `LspBackend` interface (testable without lnd).
- `src/lnd-client.ts` — `LndRestClient`: `getInfo()`, `openChannel({nodePubkeyHex, localFundingSat, pushSat})` via lnd REST. Injected with `{restUrl, macaroonHex, tlsCert, fetch}`.
- `src/bitcoind-client.ts` — `mineBlocks(n)` via bitcoind JSON-RPC (regtest confirm).
- `src/config.ts` — reads env (no hardcoded secrets).

## 4. lnd / bitcoind access

- **lnd REST:** `fetch` to `LND_REST_URL` (default `https://127.0.0.1:8088`) with header `Grpc-Metadata-macaroon: <LND_MACAROON_HEX>` and the lnd TLS cert (`LND_TLS_CERT_PATH`) trusted for HTTPS. OpenChannel: `POST /v1/channels` with `{ node_pubkey_string, local_funding_amount, push_sat, private:true, commitment_type:"STATIC_REMOTE_KEY" }`.
- **bitcoind RPC:** `BITCOIND_RPC_URL` (default `http://127.0.0.1:18443`), `BITCOIND_RPC_USER`/`PASS` (regtest `libre`/`listener`), method `generatetoaddress` to confirm the channel.
- **Dev setup:** a documented one-time `docker cp` extracts `admin.macaroon` (→ hex) and `tls.cert` from `libre-lnd` into a gitignored local dir; env vars point at them. Exact in-container paths are discovered in the plan via `docker exec libre-lnd find`.

## 5. JSON-RPC surface (exact, matches the SDK client)

`POST /lsps2`, body `{ jsonrpc:"2.0", id, method, params }`.

- `lsps2.get_versions` → `result: { versions: [1] }`
- `lsps2.get_info` → `result: { opening_fee_params_menu: [{ opening_fee_params_id:"dev", min_fee_msat:"0", proportional_fee_ppm:0, min_lifetime_blocks:2016, cltv_expiry_delta:144, valid_until:"<now+1h ISO>" }], min_payment_size_msat:"1000", max_payment_size_msat:"100000000" }`
- `lsps2.buy` (`params: { client_node_id, opening_fee_params, payment_size_msat? }`) →
  1. `lnd.openChannel({ nodePubkeyHex: client_node_id, localFundingSat: CHANNEL_CAPACITY_SAT (default 1_000_000), pushSat: PUSH_SAT (default 200_000) })`.
  2. `bitcoind.mineBlocks(3)` to confirm the channel.
  3. Read the now-confirmed channel's real `short_channel_id` from lnd (`GET /v1/channels` filtered to this peer/funding point), formatted as a BOLT11 SCID string.
  4. `result: { jit_channel_scid: <real confirmed scid>, lsp_node_id: <lnd pubkey>, client_node_id, payment_size_msat: params.payment_size_msat ?? "0", cltv_expiry_delta: 144 }`.
- Unknown method → `error: { code:-32601, message:"Method not found" }`.

The listener already sets `trustedZeroConfPeers` to the configured regtest LSP, but this server opens a **confirmed** (mined) non-anchor channel, so 0-conf trust isn't required for funding to succeed.

## 6. Funding UX (no app changes)

1. Run the server (`pnpm --filter @libre/lsps2-server dev`) + the docker stack.
2. In the app (regtest), Connect Peer to `libre-lnd`, ensure **LSP API URL** = `http://127.0.0.1:9099/lsps2` (the default).
3. Click **Request Invoice** → `get_info` + `buy` → server opens + confirms the channel → **channel + ~200k spendable balance appear** in the wallet.
4. Test send (keysend boost) and receive (create invoice, pay from `libre-lnd`).

## 7. Error handling

- lnd/bitcoind HTTP errors → caught, logged via injected logger, returned as JSON-RPC `error` with a descriptive message (no silent catch — repo guardrail).
- `buy` with a malformed `client_node_id` (not 66-hex) → JSON-RPC error before calling lnd.

## 8. Testing (TDD; vitest, node env)

- **`jsonrpc.ts` unit tests** with a fake `LspBackend`: `get_versions`/`get_info` return the exact shapes; `buy` calls `backend.openAndConfirm(clientNodeId)` once with the parsed pubkey and returns the buy result; unknown method → -32601; bad `client_node_id` → error without touching the backend.
- **`lnd-client.ts` unit tests** with mocked `fetch`: `openChannel` POSTs `/v1/channels` with the correct body (node_pubkey_string, local_funding_amount, push_sat, commitment_type STATIC_REMOTE_KEY, private) and the macaroon header; non-2xx → throws with the lnd error text.
- **`bitcoind-client.ts`**: `mineBlocks` posts the right JSON-RPC; error surfaced.
- Do **not** mock at a layer below the HTTP boundary; no real lnd needed for unit tests.
- **Manual integration:** documented in the plan — run server + stack, fund via the app, verify channel/balance, then a keysend boost.

## 9. Scope summary

**In:** new `@libre/lsps2-server` package (JSON-RPC + lnd REST + bitcoind mine), config-only wiring via `lsp-api-url`.
**Out (follow-up):** HTLC-interception JIT, mainnet LSP, LSPS1, fees, turning the dev push into real pay-to-open.
