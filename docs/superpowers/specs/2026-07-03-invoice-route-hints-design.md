# Explicit Invoice Route Hints — Design

**Date:** 2026-07-03
**Package:** `@libre/listener-wallet` (SDK — extension and PWA inherit via `buildInvoice`)
**Status:** Approved (user picked this over closing/reopening the channel private)

## Problem

LDK's `create_invoice_from_channelmanager` includes route hints only when ALL channels are
private; one public channel → zero hints ("Not including channels in invoice route hints on
account of public channel …"). A browser wallet is an unannounced-address, mostly-offline leaf
node, and external pathfinders (proven live 2026-07-03: Strike, Zeus embedded, Primal) refuse
to route to it from graph data alone — every external payment fails "no route" while a direct
payment from the channel peer settles fine. Result: invoices from a wallet whose channel was
opened public are unpayable from the outside world.

## Goal

Every invoice the SDK issues carries a last-hop route hint whenever a usable hintable channel
exists — regardless of whether the channel is public. Hints for public channels are legal
BOLT11; payers simply use the handed edge instead of judging the leaf node.

## Non-Goals

- Hand-building invoices from scratch (rejected: duplicates payment-secret registration,
  feature bits, CLTV handling — all already proven inside LDK's builder).
- The npm `bolt11` package at runtime (native `secp256k1`, `bn.js`, `lodash` — Node-only
  stack; it becomes a DEV-ONLY dependency for cross-validation in tests).
- Changing claim/persistence paths (untouched — the LDK-built invoice's hash/secret stay).

## Design

### 1. `bolt11-hints.ts` — pure invoice transformer (new SDK module)

BOLT11 structure: `bech32(hrp, timestamp[7 words] ++ tagged-fields ++ signature[104 words])`,
signature = recoverable ECDSA over `sha256(utf8(hrp) ++ bytes(data-words-before-signature))`.
Because tagged fields are self-delimiting `[type(1) | len(2) | payload(len)]` word runs, we can
carry every existing field VERBATIM and append one tag. Exports (all pure):

- `hasRouteHint(invoice: string): boolean` — bech32-decode words, walk tags, look for type 3
  (`r`).
- `appendRouteHints(invoice: string, hints: HintHop[], nodeSecretKey: Uint8Array): string` —
  drop the 104 signature words, append the encoded `r` tag(s) (one tag per hint path; each hop
  51 bytes: pubkey 33 ‖ scid 8 ‖ fee_base_msat u32 ‖ fee_proportional_millionths u32 ‖
  cltv_expiry_delta u16, big-endian, then 8-bit→5-bit with zero padding), recompute the
  recoverable signature with `@noble/curves` secp256k1, re-encode with `@scure/base` bech32
  (length limit lifted — invoices exceed 90 chars).
- `interface HintHop { srcNodeId: string; scid: bigint; feeBaseMsat: number; feeProportionalMillionths: number; cltvExpiryDelta: number }`

Signature/payee invariant: LDK invoices carry no `n` tag — the payee is recovered from the
signature — so re-signing with the node's own secret (`keysManager.get_node_secret_key()`)
leaves the recovered payee identical. The transformer asserts the recovery round-trip
(recovered pubkey == pubkey derived from the provided secret) before returning.

### 2. Hint selection — `selectHintChannels` (pure)

From `list_channels()`-shaped data: keep channels that are `is_usable`, have counterparty
`forwarding_info` (fee base/proportional + cltv_expiry_delta — unknowable before the peer's
first channel_update), and an inbound SCID (`get_inbound_payment_scid()` falling back to
`short_channel_id`). Sort by `inbound_capacity_msat` descending, take up to 3. Pure function
over plain objects so it unit-tests without LDK.

### 3. Wiring — `buildInvoice` (SDK `index.ts`)

After the existing LDK builder returns the invoice string:

```
if (!hasRouteHint(invoice)) {
  hints = selectHintChannels(this.listChannelDetails())
  if (hints.length) invoice = appendRouteHints(invoice, hints, keysManager.get_node_secret_key())
}
```

- Invoice already hinted (all-private-channel wallet) → untouched: the proven path stays the
  proven path.
- No usable hintable channels (brand-new wallet) → untouched hint-less invoice, as today.
- Failure inside the transformer → log via injected Logger and **return the original LDK
  invoice** (a hint-less invoice that direct peers can pay beats a thrown error).

### 4. Dependencies

`@noble/curves` + `@scure/base` become direct SDK dependencies (currently transitive via
nostr-tools; pure JS, audited, browser-first). `bolt11` is added as a devDependency only.

## Error handling

- `appendRouteHints` throws on malformed input (bad bech32, missing signature section,
  recovery mismatch); `buildInvoice` catches, logs, and falls back to the unhinted original.
- Zero silent catches — the fallback is logged through the injected Logger per conventions.

## Testing (per testing-strategy: no LDK mocking; MSW/plain objects for the rest)

1. **Pure round-trip (no WASM):** build a base invoice in-test with the npm `bolt11` dev dep
   (random key), `appendRouteHints`, decode with npm `bolt11`: all original fields byte-equal,
   `routing_info` present with the exact hop values, signature valid, payee unchanged.
2. **LDK cross-validation (real WASM):** parse the transformed invoice with the bindings' own
   `Bolt11Invoice.constructor_from_str` → `check_signature()` ok, route_hints() length 1,
   payee/recovered pubkey matches the signing key.
3. **`selectHintChannels`:** pure-object cases — filters non-usable / missing forwarding_info,
   SCID fallback order, capacity sort, cap at 3.
4. **`buildInvoice` no-channel path (real LDK, jsdom + MSW):** fresh wallet, createInvoice →
   invoice has no hints and is unchanged by the wiring (transformer not invoked / no-op).
5. **Live mainnet proof (user):** create an invoice in the extension → decode shows the `r`
   tag → pay from Strike/Zeus, which failed today without hints.

## Security notes

- `get_node_secret_key()` never leaves the wallet instance; the transformer takes it as a
  parameter and holds no state (key-isolation guardrail: it stays inside the client sandbox).
- The transformation cannot mint a valid invoice for a different payee: re-signing with the
  node key reproduces the same recovered payee, and tests assert it.
- Hint data is public-by-nature (it's the channel's own gossip policy).
