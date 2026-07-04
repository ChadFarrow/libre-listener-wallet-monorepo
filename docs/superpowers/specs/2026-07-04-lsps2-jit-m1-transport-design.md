# LSPS2 JIT — Milestone 1: LSPS0 custom-message transport + `lsps2.get_info`

**Date:** 2026-07-04
**Status:** Approved (design)
**Part of:** the LSPS2 JIT client (Tier 1 "Bootstrap Onboarding" / First Deposit in the main-repo architecture). Milestone 1 of 3 — see "Scope & milestones".

## Why

The main repo's **Multi-Tier Liquidity Engine** makes **LSPS2 JIT** the Tier-1 bootstrap: a brand-new wallet with `0 channels` funds itself in **one payment** — the user pays an invoice from an external service (Strike/Cash App), the LSP HTLC-intercepts it, opens a **zero-conf** channel, deducts its fee atomically, and forwards the remainder onto the user's side. One payment yields a channel usable **both directions at once** (spendable balance + remaining inbound). This is the correct onboarding for a *listener* wallet, whose user is a net **sender** and therefore needs outbound liquidity from day one (incoming boosts don't fund a listener).

Real mainnet LSPs (Megalith, Olympus/ZEUS) expose LSPS2 over **BOLT8 lightning-peer custom message type 37913** (bLIP-50 / LSPS0 transport), **not** HTTP. The existing regtest dev LSP speaks LSPS2 over HTTP JSON-RPC and its client-claim never worked (an lnd-interceptor artifact). So the real BOLT8 path is unbuilt. The `ws-bridge` (already deployed) lets a browser node reach these LSPs as a peer; what's missing is the **custom-message transport** to actually talk LSPS2 to them.

Feasibility is confirmed against the `lightningdevkit@0.1.0` WASM bindings: `CustomMessageHandler.new_impl`, `CustomMessageReader.new_impl`, `Type.new_impl({type_id, write, debug_str})`, `TwoTuple_PublicKeyTypeZ.constructor_new(pubkey, Type)`, `PeerManager.process_events()`, plus `accept_underpaying_htlcs` / `counterparty_skimmed_fee_msat` (for milestone 2). The LDK docs describe the JIT-claim (`accept_underpaying_htlcs` + intercept-scid route hints) as a first-class supported flow.

## Scope & milestones

The full JIT client is decomposed into three self-contained specs; **this doc is milestone 1 only.**

1. **M1 (this spec):** LSPS0 custom-message transport (type 37913) + `lsps2.get_versions` / `get_info`. Prove we can talk LSPS2 to a real mainnet LSP and get a fee menu. **Gate 1 — free, no sats.** If neither LSP answers LSPS2, we pivot before spending anything.
2. **M2 (later):** `buy` → wrapped invoice (force the intercept SCID into the route hint) → `accept_underpaying_htlcs` → accept the 0-conf JIT channel → claim the skimmed HTLC. **Gate 2 — one small real-sats end-to-end proof.**
3. **M3 (later):** app UX — the "fund your wallet in one payment" self-funding flow (extension/PWA), and `.well-known/lightning-providers.json` registry discovery.

M1's live outcome (which LSP, their exact fee-param shape, their SCID/alias format) directly informs M2's design, so M2 is deliberately **not** designed here.

## Components (all new, `packages/libre-listener-wallet/src/`)

### `lsps-message.ts` (pure — bLIP-50 wire format)
- `LSPS_PEER_MSG_TYPE = 37913`.
- `encodeLspsMessage(obj: object): Uint8Array` — UTF-8 bytes of the JSON string. **No length prefix and no 2-byte type prefix** — LDK's `PeerManager` frames the message and prepends the type from `Type.type_id()`; `Type.write()` must return only the body.
- `decodeLspsMessage(bytes: Uint8Array): any` — UTF-8 → `JSON.parse`.
- JSON-RPC 2.0 helpers: `buildRequest(method: string, params: object, id: string): object` (`{jsonrpc:"2.0", id, method, params}`), `parseResponse(obj): { id: string; result?: any; error?: {code:number;message:string;data?:any} }`.
- `newRequestId(): string` — unique per request via `crypto.getRandomValues` (available in browser + Node); tests assert uniqueness across calls, not exact values.

### `lsps-peer-client.ts` (correlation layer + LDK trait impls)
- State: an outbound queue `Array<{ peer: Uint8Array; obj: object }>` and a pending map `Map<string, { resolve; reject; timer }>`.
- `buildCustomMessageHandler(): CustomMessageHandler` via `CustomMessageHandler.new_impl(handlerIface, readerIface)`:
  - **reader** `read_custom_message(messageType, buffer)`: if `messageType === 37913`, return `Type.new_impl({ type_id: () => 37913, write: () => buffer, debug_str: () => "lsps" })` carrying the raw bytes; LDK only calls this for message types not consumed by the channel/routing/onion handlers.
  - **handler** `handle_custom_message(msg, senderNodeId)`: `decodeLspsMessage(msg.write())` → `parseResponse` → look up `id` in the pending map → `resolve(result)` or `reject(error)`; unknown/absent id → ignore. Always returns `Ok` (never throws into LDK).
  - **handler** `get_and_clear_pending_msg()`: drain the outbound queue into `TwoTuple_PublicKeyTypeZ.constructor_new(peer, Type.new_impl({ type_id: () => 37913, write: () => encodeLspsMessage(obj), debug_str }))[]`.
  - **handler** `provided_node_features()`: empty `NodeFeatures` for now (revisit only if the live gate shows an LSP ignoring a peer that didn't advertise the LSPS feature bit).
- `setPeerManager(pm)` — injected after PeerManager is constructed (the handler is built *before* the PeerManager, then the client gets the pm reference to flush).
- `request(peerPubkeyHex: string, method: string, params: object, opts?: { timeoutMs?: number }): Promise<any>` — `newRequestId()`, push `{peer, obj: buildRequest(...)}`, call `peerManager.process_events()`, register the pending promise with a timeout (default 15000 ms) that rejects and removes the entry.
- Thin wrappers: `getVersions(peer): Promise<Lsps2GetVersionsResponse>`, `getInfo(peer, { version, token? }): Promise<Lsps2GetInfoResponse>`.

### Wiring in `index.ts`
- Build the peer client + its `CustomMessageHandler` before the `PeerManager`; pass the handler to `PeerManager.constructor_new(...)` in place of `ignoringHandler.as_CustomMessageHandler()` (currently ~line 562); after construction call `peerClient.setPeerManager(this.peerManager)`.
- New SDK method **`getLSPS2Info(opts: { lspPubkey: string; lspHost: string; lspPort: number }): Promise<Lsps2GetInfoResponse>`** — ensure the peer is connected (via the existing `connectPeer`, which dials through the bridge), `getVersions` → choose the highest mutually-supported version → `getInfo`, return the menu. This is the Gate-1 deliverable.

The `Lsps2GetVersionsResponse` / `Lsps2GetInfoResponse` / `Lsps2OpeningFeeParams` types already exist in `@libre/shared`.

## Data flow (`get_info`)

```
SDK.getLSPS2Info()
  → connectPeer(lsp via ws-bridge)                    // already works
  → peerClient.getVersions(lsp):
       queue {lsps2.get_versions} → process_events()
       → PeerManager frames+sends peer-msg 37913 → LSP
  → LSP → 37913 → PeerManager → reader.read_custom_message
       → handler.handle_custom_message → resolve getVersions
  → peerClient.getInfo(lsp,{version}): same round-trip
       → returns { opening_fee_params_menu, min/max_payment_size_msat }
```

## Error handling
- Per-request **timeout** (default 15 s) → reject with a clear message ("LSP did not answer LSPS2 `<method>`"); the caller surfaces it.
- Malformed/undecodable response → `reject` + `logger` warning; never throw into LDK's `handle_custom_message`.
- Connection failure (bridge/handshake) surfaces from `connectPeer` as today.
- No silent catches (guardrail): correlation errors log via the injected `Logger` and reject the pending promise.

## Testing (TDD; do not mock LDK internals)
- **Pure units — `lsps-message.test.ts`:** `encodeLspsMessage`/`decodeLspsMessage` round-trip (incl. UTF-8, exact bytes = JSON with no prefix); `buildRequest`/`parseResponse` (result, error, and missing-id shapes); `newRequestId` uniqueness.
- **Handler unit with REAL LDK WASM — `lsps-peer-client.test.ts`** (jsdom, no network, no PeerManager): build the handler; (a) call `request(...)` then `get_and_clear_pending_msg()` → assert one pair, its `Type.type_id() === 37913` and `Type.write()` decodes to the expected JSON-RPC request; (b) construct a response `Type` (via `Type.new_impl` with the encoded response bytes) and call `handle_custom_message` → assert the `request` promise resolves with the parsed `result`; (c) a response with an unknown id is ignored (no throw, promise still pending); (d) `timeoutMs` elapses → promise rejects and the pending entry is cleared (use vitest fake timers — `vi.useFakeTimers()`/`vi.advanceTimersByTime` — for determinism).
- **Gate-1 live check — `getLSPS2Info` against mainnet (manual/opt-in, NOT in CI):** with `docker`/bridge reachable and a mainnet wallet, call against Megalith (`038a9e56512ec98da2b5789761f7af8f280baf98a09282360cd6ff1381b5e889bf@64.23.162.51:9735`) and Olympus (`031b301307574bbe9b9ac7b79cbe1700e31e544513eae0b5d7497483083f99e581@45.79.192.236:9735`). **Pass:** a non-empty `opening_fee_params_menu` returns from at least one → LSPS2 supported, transport proven. **Fail (both silent/timeout):** they likely offer only LSPS1 → record it and pivot (seek an LSPS2 LSP via the future registry) before starting M2.

## Guardrails / constraints
- Package manager pnpm; files kebab-case, functions camelCase, types PascalCase.
- SDK stays platform-agnostic: no `window`/`fetch`/`process.env` in these modules; `Logger` is injected. The peer client depends only on the LDK bindings + injected logger.
- Barrel exports from `index.ts`; import types from `@libre/shared`.
- Do NOT mock LDK internals — the handler test drives the *real* LDK `CustomMessageHandler`/`Type`.
- Unclaimed-HTLC preimages / keys never leave the sandbox (not touched in M1, but the peer client must never log message bodies that could carry secrets in later milestones — log metadata only).

## Risks / open questions (resolved at first live contact)
- **`write()` body framing:** must return only the JSON body (LDK prepends the 2-byte type). Pinned by the encode test + the first live round-trip; if the LSP rejects our frame, inspect whether it expects a different envelope.
- **LSPS feature bit:** `provided_node_features()` is empty; if an LSP ignores our messages because we didn't advertise the LSPS feature bit in `init`, set it (needs the feature-bit position and a `NodeFeatures` builder in the bindings).
- **Do Megalith/Olympus actually run LSPS2?** Unknown until the gate — that's the whole point of M1.

## Out of scope (M1)
`buy`, wrapped invoice / intercept-SCID route hints, accepting the 0-conf JIT channel, the skimmed-HTLC claim, the `.well-known/lightning-providers.json` registry (M1 uses the two known LSP pubkeys), any app/extension UX, and multi-LSP fee comparison — all milestone 2/3.
