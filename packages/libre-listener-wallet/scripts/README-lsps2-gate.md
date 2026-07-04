# LSPS2 Gate-1: `lsps2-getinfo-gate.mjs`

Manual, opt-in script. **Not run in CI.** It is the go/no-go check for LSPS2 JIT milestone 2:
does a real mainnet LSP (Megalith, Olympus/ZEUS) actually answer `lsps2.get_info` over the
BOLT8 peer-message transport (custom message type 37913)? If yes, milestone 2 (buy + wrapped
invoice + claim) can proceed with the real fee-param shape in hand. If no LSP answers, LSPS2
is not viable against these providers yet and milestone 2 is blocked pending an LSPS2-capable
LSP (check the `.well-known` LSP registry).

## What it does

Boots a throwaway LDK node on **mainnet** with in-memory (non-persistent) storage — nothing is
written to disk, no seed is reused across runs, no channel state exists. It connects out through
the deployed ws-bridge to each LSP's Lightning node, runs `lsps2.get_versions` then
`lsps2.get_info`, and prints the returned fee-param menu (or the error/timeout).

**It spends no sats.** `get_info` is a pure read query — no channel is opened, no invoice is
paid, no HTLC is sent. The node it boots holds no funds (fresh seed, zero balance) and is
discarded when the process exits.

## Prerequisites

1. Build the SDK so `../dist/index.mjs` exists (the script imports the built package, not `src/`):

   ```bash
   pnpm --filter @libre/listener-wallet build
   ```

2. The ws-bridge must already be deployed with Megalith and Olympus's node addresses allowed
   in its `BRIDGE_ALLOWLIST` — it is (`wss://ws-bridge-production-9e2f.up.railway.app`). A
   browser/Node wallet has no listening socket, so it can only reach these LSP nodes by dialing
   out through this bridge (see the "browser node has no listening socket" gotcha in the
   monorepo `CLAUDE.md`).

3. Node 22+ (for the global `WebSocket` — no `ws` package dependency needed).

## Run it

From the package directory:

```bash
cd packages/libre-listener-wallet
node scripts/lsps2-getinfo-gate.mjs
```

Allow up to ~60s: it initializes LDK WASM, does an initial chain sync (mainnet tip header via
Esplora), then dials each LSP through the bridge and waits for their LSPS2 responses.

## Reading the result

- **PASS** — at least one LSP (`Megalith` and/or `Olympus`) prints:

  ```
  === Megalith: LSPS2 SUPPORTED ✓ ===
    min_payment_size_msat: ...
    max_payment_size_msat: ...
    opening_fee_params_menu: [ ... ]
  ```

  This means the BOLT8 LSPS transport works end-to-end (bridge dial → peer handshake → custom
  message round-trip) and the LSP genuinely offers LSPS2. Gate 1 passes — proceed to design
  milestone 2 (`buy` + wrapped invoice + claim) using the real `opening_fee_params_menu` shape
  returned here (field names, whether `promise` is HMAC-signed, `min_lifetime_blocks`,
  `proportional_fee_ppm`, `min_fee_msat` values all matter to the `buy` design).

- **FAIL** — both LSPs print `NO LSPS2 (or timeout/error) — ...` (peer handshake failure,
  `get_versions` timeout, or an empty/zero version list):

  This means neither LSP answers LSPS2 over their public Lightning node (at least not over this
  transport path). Record the outcome in the `mainnet-lsp-integration` memory and stop milestone
  2 until an LSPS2-capable LSP is found (check the LSP `.well-known` registry for one that
  advertises LSPS2 support).

A mixed result (one LSP passes, one fails) is still a **PASS** — milestone 2 can target the
LSP that answered.

## Troubleshooting

- `bridge connect failed for <host>:<port>` — the ws-bridge rejected or couldn't reach that
  target; confirm the bridge's `BRIDGE_ALLOWLIST` still includes it and the bridge deployment is
  up.
- Hang with no output past "Connecting to ... via bridge..." for a long time — the peer
  handshake or `get_versions` request never got a reply; let it run to its internal timeout
  rather than assuming a hang, then treat a final timeout message as FAIL for that LSP.
- WASM load error — confirms Step 1 (build) wasn't run, or `node_modules/lightningdevkit` is
  missing; rerun `pnpm install` at the repo root.
