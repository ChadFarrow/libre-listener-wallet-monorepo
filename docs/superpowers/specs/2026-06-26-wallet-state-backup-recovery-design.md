# Wallet State Backup & Recovery — Design

**Date:** 2026-06-26
**Status:** Approved (design)
**Branch:** `feat/wallet-state-backup`

## Problem

The Libre Listener Wallet is **non-custodial**: the user's funds live in a
browser-resident LDK node whose entire state (seed, channel manager, channel
monitors) is persisted **only in IndexedDB**. Browser storage is not durable —
WebKit/Safari evicts IndexedDB after ~7 days of no site interaction (ITP), users
clear browsing data, private windows are ephemeral, and devices are lost. In
Lightning, losing the latest **channel monitor** state is not merely "lost
records": broadcasting a stale state can be penalized (loss of the entire channel
balance), and without monitors the node cannot force-close to recover. So on
mainnet an IndexedDB wipe means **permanent, real fund loss**.

There is today no encrypted external backup and no recovery path. The serialization
logic itself is sound (`persistence.test.ts` proves cold-boot recovery within the
same storage), so the gap is durability and portability of that state — not the
encoding.

## Goal (Phase 1)

Give the wallet a **provable recovery story**: the user can produce an encrypted
backup of full wallet state and restore it into a fresh browser/device, recovering
their channels and funds. Prove it with an automated regtest integration test, and
expose it in the example app. Design the mechanism so automated backup-on-state-
change (Phase 2) reuses the same path.

### Non-goals (explicitly deferred to Phase 2)
- Remote/automated backup server (VSS-style auto-push on state change).
- Password-based encryption (Phase 1 derives the key from the seed only).
- Mainnet operation (Phase 1 proving ground is regtest + signet).

## Recovery model

Two distinct artifacts with different lifecycles:

- **Seed** (root secret, 32-byte LDK seed stored as `ldk_seed`). Backed up **once**
  by the user. Restores node identity and on-chain funds.
- **Channel state** (channel manager + channel monitors). Changes on **every
  payment**. Protects channel balances.

The encrypted backup blob contains *both*, but is encrypted with a key **derived
from the seed**. Therefore restoring requires the user to supply the seed
out-of-band (their written-down backup):

- Blob alone is useless without the seed → a leaked backup file is not stolen funds.
- Seed alone (lost blob) still gives on-chain recovery, just not the latest channel
  state.

**Honest limitation:** a manually-exported blob goes stale the moment the wallet
transacts again. Restoring a stale channel backup on mainnet can itself trigger a
penalty. Phase 1 manual export is therefore a *signet-proving tool and safety net*,
not the mainnet answer — which is Phase 2 automated backup-on-state-change, built on
the same encrypt/serialize path.

## Component 1 — SDK: `exportState()` / `importState()`

Location: `packages/libre-listener-wallet/src`. New module `state-backup.ts` for the
crypto + (de)serialization helpers; two methods added to `LibreListenerWallet`.

### State enumeration (no blind spots)
All critical state is reachable without a new storage capability:
- **KVStore-managed keys** (channel monitors, monitor updates): read the index key
  `ldk_keys_index` (a JSON array maintained by `StorageCache`), then read each listed
  key.
- **Direct keys**: `ldk_seed`, `channel_manager`, `network_graph`, `scorer`.

`network_graph` and `scorer` are re-syncable and included for convenience, not
safety. The export records which keys it captured so import is exact.

### Serialization & encryption
- Bundle: `{ [storageKey]: hexValue }` for every captured key, plus metadata
  `{ version, network, exportedAt }`.
- Encrypt with **AES-256-GCM** via WebCrypto `crypto.subtle`. Key derived from the
  raw seed bytes via **HKDF-SHA256** (seed is high-entropy, so HKDF — not PBKDF2 —
  is appropriate). Random 12-byte IV per export.
- Output: a versioned JSON envelope, base64 fields:
  `{ "v": 1, "alg": "AES-256-GCM", "kdf": "HKDF-SHA256", "iv": "...", "ct": "..." }`.

### API
```ts
// Returns the encrypted backup envelope as a string (caller downloads/stores it).
exportState(): Promise<string>

// Decrypts envelope with a key derived from seedHex, writes all entries into
// storage (including rebuilding ldk_keys_index). Throws on wrong seed / bad blob /
// version mismatch. Must be called on a NOT-yet-started wallet; caller then start()s.
importState(envelope: string, seedHex: string): Promise<void>
```

Error handling per project convention: typed failures / thrown `Error`s with clear
messages (wrong seed → GCM auth failure surfaced as "decryption failed — wrong seed
or corrupt backup"). No silent catches.

### Guardrail compliance
- Encryption happens locally before the blob ever leaves the sandbox (satisfies the
  "encrypted at rest before transmission" guardrail).
- No key material is logged. The seed is never emitted except inside the encrypted
  ciphertext.

## Component 2 — Automated recovery proof (primary deliverable)

New regtest integration test:
`packages/libre-listener-wallet/src/tests/integration/recovery.test.ts`

Reuses the proven LSPS2 JIT + keysend scaffolding. Requires the regtest stack with
`--noseedbackup` + `--accept-keysend` (already in `docker-compose.yml`) and
`scripts/regtest-setup.sh`.

Flow:
1. **Wallet A** — `storageA` (Map). Start, open zero-conf JIT channel from LND, claim
   a 20 000-sat payment. A now has a live channel + spendable balance.
2. `const seed = <ldk_seed from storageA>; const blob = await walletA.exportState();`
3. `await walletA.stop();`
4. **Wallet B** — **fresh empty `storageB`** (simulates wiped browser / new device).
   `await walletB.importState(blob, seed)` (which restores `ldk_seed` and all channel
   state into `storageB` from the decrypted blob), then `await walletB.start()` (which
   boots from the restored `ldk_seed`).
5. **Assert recovery:** B's channel manager lists the same channel id and the same
   balance as A had.
6. **Assert funds are usable:** B sends a keysend boost to LND and LND receives it
   (reusing the keysend-receipt assertion) — proving recovered channel state is not
   just present but *operational*.

Negative test: `importState(blob, wrongSeed)` rejects with a decryption error.

A unit test (`state-backup.test.ts`, jsdom) covers the encrypt→decrypt round-trip and
the wrong-seed failure without the LDK node, for fast feedback.

## Component 3 — example-app UX (secondary deliverable)

Enhance `packages/example-app`:
- **Seed backup gate on creation:** when a new seed is generated, show it and require
  an explicit "I have written down my seed" confirmation before proceeding.
- **Export:** "Download encrypted backup" → calls `exportState()`, saves a `.json`.
- **Restore:** "Restore from backup" → file picker + seed entry → `importState()` →
  `start()`.
- Point the app's default config at **signet/Mutinynet** (`esploraUrl`
  `https://mutinynet.com/api`) for real-Lightning manual testing; regtest remains the
  automated proving ground.

No new package; reuse existing wallet/storage wiring.

## Testing strategy

Follows `ai/contracts/testing-strategy.md`: no LDK mocking; real LDK in unit tests;
integration against the regtest stack; assert outcomes (recovered balance, received
keysend), not internals. TDD: write `state-backup.test.ts` round-trip first, then the
SDK methods, then the integration recovery test.

## Risks / open questions
- **Stale backup** (documented above) — accepted for Phase 1; mitigated by app
  nudging "export again after activity" and resolved by Phase 2.
- **Channel reserve / dust:** the recovered-wallet keysend amount must stay within
  spendable balance minus channel reserve (the keysend test already validated 5 000
  sat over a 500 000-sat channel with 20 000 local).
- **WebCrypto availability:** `crypto.subtle` exists in browsers and Node ≥ 16
  (`globalThis.crypto`), so the same code path works in jsdom/node tests and the
  browser.

## Deliverables
1. `src/state-backup.ts` — crypto + (de)serialization helpers.
2. `exportState()` / `importState()` on `LibreListenerWallet`.
3. `src/tests/unit/state-backup.test.ts` — round-trip + wrong-seed.
4. `src/tests/integration/recovery.test.ts` — wipe → restore → funds survive → keysend.
5. example-app: seed-backup gate, export/restore UI, signet default.
