# Rock-Solid Backup & Recovery — Design

- **Date:** 2026-06-27
- **Status:** Approved (pending spec review)
- **Scope:** `@libre/listener-wallet` SDK (`state-backup.ts`, `index.ts`) + `@libre/example-app` (creation/restore/Drive flows)
- **Out of scope (follow-up spec):** network-namespaced storage keys (the separate regtest-over-mainnet corruption bug)

## 1. Background / Why

A real (small) mainnet channel was lost because the funding wallet was created in a **Chrome Incognito** window. Incognito keeps IndexedDB in memory only, so:

- The randomly generated LDK seed never persisted to disk (absent from Time Machine snapshots, swap is encrypted, Chrome memory is sealed on Apple Silicon).
- Every backup (local downloads + Google Drive) was encrypted **with that seed** via HKDF (`state-backup.ts`), and the seed is stored *inside* the encrypted blob — a catch-22: you need the seed to decrypt the backup that contains the seed.
- When the incognito window closed, the only copy of the seed was destroyed, making all backups permanently undecryptable.

Two root causes: **(a)** wallet state created in non-persistent storage, and **(b)** the backup's only decryption key was a secret that was never recorded out-of-band.

## 2. Goals / Non-Goals

**Goals**
- A backup that can be restored as long as the user retains **either** of two independent secrets, neither of which can be silently destroyed.
- Make it impossible to create a wallet in storage that won't survive the session.
- Prove, before any funds are added, that recovery actually works end-to-end (including from Google Drive).
- Keep the Google Drive auto-sync (already built) as the off-device home for the encrypted backup.

**Non-Goals**
- Network-namespaced storage keys (separate follow-up).
- Changing the LDK/keysend/LSP logic.
- Server-side/custodial backup. The gateway never touches keys (guardrail).

## 3. Recovery & Threat Model

The user keeps **two independent things**:

| Secret | Where it lives | Recovers |
|---|---|---|
| **Passphrase** | Password manager (Bitwarden) | Decrypts the Drive backup |
| **Seed** (64-hex, shown once at creation) | Paper / Bitwarden, offline | Decrypts the Drive backup *and* is the on-chain master key |

Recovery succeeds with **any one** of:
- `Drive backup + passphrase`, or
- `Drive backup + seed`.

**Guardrail compliance:** the encrypted backup may live in Google Drive freely — it leaks nothing without a secret. The passphrase MUST NOT be stored in the same Drive (or it recreates the catch-22 and breaks key isolation). The seed-derived wrap is computed locally; the seed never leaves the sandbox. No secret is ever logged.

## 4. Backup Format — Envelope v2 (the core change)

Replace the v1 "encrypt the whole payload directly with a seed-derived key" scheme with **envelope encryption** so multiple secrets can each open the same backup.

### Structure
```jsonc
{
  "v": 2,
  "alg": "AES-256-GCM",
  "iv":  "<base64>",          // IV for the payload encryption
  "ct":  "<base64>",          // payload ciphertext: JSON BackupPayload (entries incl ldk_seed + channel state)
  "recipients": [
    { "type": "passphrase", "kdf": "PBKDF2-SHA256", "iter": 600000,
      "salt": "<base64>", "iv": "<base64>", "wrap": "<base64>" },   // DEK wrapped with passphrase-derived KEK
    { "type": "seed", "kdf": "HKDF-SHA256",
      "info": "libre-wallet-backup-kek-v2", "iv": "<base64>", "wrap": "<base64>" } // DEK wrapped with seed-derived KEK
  ]
}
```

### Crypto
- **DEK** (data encryption key): random 32 bytes; AES-256-GCM key. Encrypts the payload once (`iv` + `ct`).
- **Passphrase KEK:** `PBKDF2-SHA256(passphrase, salt, 600000)` → AES-256-GCM key. Wraps (AES-GCM-encrypts) the 32-byte DEK → `recipients[passphrase].wrap`.
- **Seed KEK:** `HKDF-SHA256(seedBytes, salt=∅, info="libre-wallet-backup-kek-v2")` → AES-256-GCM key. Wraps the same DEK → `recipients[seed].wrap`.
- Each wrap has its own `iv`. All WebCrypto (`crypto.subtle`) — **no new dependencies** (works in browser and Node ≥18 via `globalThis.crypto`).

### Decryption
- `decryptAndParse(envelope, secret)`:
  - `v === 2`: pick the recipient matching the secret (64-hex string ⇒ `seed`; otherwise ⇒ `passphrase`; if the chosen one fails auth, try the other). Derive KEK → unwrap DEK → AES-GCM-decrypt `ct` → parse `BackupPayload`.
  - `v === 1`: legacy path — HKDF-from-seed over the whole `ct` (unchanged), so old backups still restore.
- GCM auth failure ⇒ `Error("Decryption failed — wrong secret or corrupt backup")`.

### `BackupPayload` (unchanged shape)
`{ version, network, exportedAt, entries }` where `entries` includes `ldk_seed`, `channel_manager`, `network_graph`, `scorer`, `ldk_keys_index`, `state_version`, and the KVStore monitor keys.

## 5. SDK API Changes (`packages/libre-listener-wallet/src/index.ts`)

- `exportState(opts?: { passphrase?: string }): Promise<string>`
  - With `passphrase` ⇒ produces **v2** (wrapped to both passphrase and the in-storage seed).
  - Without ⇒ legacy v1 (kept only for back-compat/tests). New wallets always pass a passphrase.
  - Flushes manager state first when running (unchanged).
- `importState(envelope: string, secret: string): Promise<void>`
  - Auto-detects v2/v1; `secret` may be passphrase or 64-hex seed. Writes decrypted `entries` to storage. Still refuses to run while `isRunning` (unchanged), and still enforces `payload.network === config.network`.
- `verifyBackup(envelope: string, secret: string): Promise<{ ok: boolean; network?: string; hasSeed: boolean; seedMatches?: boolean; entryKeys: string[]; error?: string }>`
  - Decrypts **without writing to storage**. Used by the app's pre-funding verification. Never returns the seed value; only booleans/metadata.
- The SDK holds **no** passphrase state; the app passes it per call (keeps the SDK stateless and platform-free).

## 6. App Changes (`packages/example-app`)

### 6.1 Persistent-storage guard (app layer only)
- `ensurePersistentStorage(): Promise<boolean>` using `navigator.storage.persisted()` then `navigator.storage.persist()`.
- New-wallet creation is **blocked** with a clear message if storage is not durable (Incognito / denied). This alone prevents the original failure. Kept out of the SDK (SDK must not touch `navigator`).

### 6.2 Safe new-wallet creation flow (`newWalletBtn`)
1. `ensurePersistentStorage()` → abort with explanation if false.
2. Generate seed; **display it**; require the user to **re-enter it** into a confirm field (proves it was captured) before continuing.
3. Prompt **passphrase twice** + minimum-strength check.
4. `storage.clear()` → write seed → set network.
5. Run **verified backup round-trip** (6.4). Only on success show the "ready to fund" state.

### 6.3 Drive auto-sync
- Keep existing app-folder, event-driven upload on channel-state advance.
- Encrypt with the **session passphrase** (held in a module variable in memory only, entered at create/start, never persisted). Each auto-upload calls `exportState({ passphrase })`.

### 6.4 Verified backup before funding ("rock solid" proof)
`createAndVerifyBackup(passphrase)`:
1. `env = await wallet.exportState({ passphrase })`
2. upload `env` to Drive
3. `redown = await drive.downloadBackup()`
4. `res = await wallet.verifyBackup(redown, passphrase)`
5. assert `res.ok && res.hasSeed && res.network === selectedNetwork`
6. (optional) also offer a local file download for the paper-seed crowd.
7. Show **"✅ Backup verified & restorable from Drive."** Any failure → explicit error, no green light.

### 6.5 Restore flow (`restoreDriveBtn` / `importStateBtn`)
- Accept **either** a 64-hex seed **or** a passphrase.
- Pull backup (Drive or file), call `importState(envelope, secret)` (v2 then v1), then Start.

## 7. Data Flow Summary

- **Create:** guard → show+confirm seed → set passphrase → write seed → export v2 (wrap to passphrase+seed) → Drive upload → re-download → verifyBackup → green light.
- **Auto-backup:** on state change → `exportState({passphrase})` → Drive (debounced, existing logic).
- **Restore:** seed *or* passphrase + Drive/file → `importState` → Start.

## 8. Error Handling

- All crypto failures surface via the injected `Logger` and a returned error/throw — no silent catches (guardrail).
- `verifyBackup` distinguishes wrong-secret vs corrupt vs network-mismatch.
- Creation refuses to proceed (does not partially write) if the storage guard fails.

## 9. Testing (TDD; Vitest)

**`state-backup` unit tests (jsdom):**
- v2 round-trip: decrypt with **passphrase** works.
- v2 round-trip: decrypt with **seed** works (same envelope).
- wrong passphrase / wrong seed ⇒ throws "Decryption failed".
- tamper a byte of `ct`/`wrap` ⇒ GCM auth failure.
- **v1 backward-compat:** an existing seed-HKDF backup still decrypts.

**SDK round-trip (real storage, no LDK mocking):**
- `exportState({passphrase})` → `importState` into a fresh `IndexedDbStorage` → `ldk_seed` and all `entries` restored byte-for-byte; via passphrase and via seed.
- `verifyBackup` returns `ok:true, hasSeed:true, seedMatches:true` without mutating storage.

**App-layer guard test:**
- Stub `navigator.storage.persisted/persist` in jsdom; assert wallet creation is blocked when non-persistent and allowed when persistent.

Rules honored: do **not** mock LDK internals; assert outcomes (restored state, booleans), not call order; gateway untouched.

## 10. Open Questions

None blocking. (KDF = PBKDF2 600k confirmed; paper-seed fallback confirmed; namespacing deferred.)
