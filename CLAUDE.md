# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

The **Libre Listener Wallet** is a zero-infrastructure, non-custodial Bitcoin Lightning wallet that runs inside browser/PWA sandboxes (and native mobile wrappers) for the Podcasting 2.0 / Value-for-Value (`v4vmusic.com`) ecosystem. It wraps **LDK (Lightning Development Kit) WASM**, persists node state in IndexedDB, opens just-in-time channels via LSP protocols, and sends V4V "boost" payments as keysend with bLIP-10 TLV metadata.

> Experimental: not production-ready. The README warns loss of funds is likely.

## Read These First

The `ai/` directory holds the authoritative contracts and design specs. When making non-trivial changes, read the relevant ones — they are the source of truth, not this file:

- `ai/contracts/guardrails.md` — hard security/architecture rules (key isolation, zero-custody gateway, DB isolation). **Violating these is a critical bug.**
- `ai/contracts/project-conventions.md` — DI patterns, TLV/bLIP-10 schema, naming, DRY rules.
- `ai/contracts/testing-strategy.md` — TDD lifecycle and the no-mocking rules below.
- `ai/reference/this-monorepo/*` — architecture, infrastructure, tech-stack, and milestone roadmap.

## Commands

Package manager is **pnpm** (`pnpm@10.10.0`); build orchestration is **Turborepo**.

```bash
pnpm install                 # install workspace deps
pnpm build                   # turbo: builds shared first, then SDK + gateway (tsup)
pnpm test                    # turbo: vitest run across all packages (depends on build)
pnpm lint                    # eslint

# Run one package's tests
pnpm --filter @libre/listener-wallet test
pnpm --filter @libre/nwc-push-gateway test

# Run a single test file / by name (vitest)
pnpm --filter @libre/listener-wallet exec vitest run src/tests/unit/keysend.test.ts
pnpm --filter @libre/listener-wallet exec vitest run -t "boost"

# Dev servers
pnpm --filter @libre/nwc-push-gateway dev    # push gateway daemon (port 3001)
pnpm --filter @libre/example-app dev         # Vite PWA playground (http://localhost:5173)

# Local regtest sandbox for integration tests (all ports bound to 127.0.0.1)
docker compose up -d         # bitcoind, electrs (esplora :3002), lnd mock LSP, websockify TCP bridge (:8081)
```

## Architecture

TypeScript monorepo (`packages/*`). Cross-package imports go through package **names**, never relative paths.

- **`packages/shared`** (`@libre/shared`) — single source of truth for protocol types: `WalletConfig`, NWC request/response, LSPS1/LSPS2 JSON-RPC shapes, V4V utils, Zod schemas. Anything shared between SDK and gateway lives here; do not duplicate type signatures across packages.
- **`packages/libre-listener-wallet`** (`@libre/listener-wallet`) — the client SDK. The `LibreListenerWallet` class (`src/index.ts`) adapts LDK's low-level bindings into a simple API: `start()`, `stop()`, `connectPeer()`, `createInvoice()` (one shared private `buildInvoice()` behind it, `requestLSPS2Invoice()`, and NWC `make_invoice`), `sendKeysendPayment()` (the single keysend path — NWC `pay_keysend` routes through it), `syncGossip()`, `onStateChanged(cb)` (fires when channel state is persisted), and encrypted backup/recovery: `exportState({ passphrase? })`, `importState(envelope, secret)` (secret = passphrase or 64-hex seed; auto-detects format; enforces network match), `verifyBackup(envelope, secret)` (decrypts WITHOUT writing storage — used to prove a backup is restorable before funding; returns `{ ok, hasSeed, seedMatches, network, entryKeys }`). Supporting modules: `nwc-manager` (takes `{logger,storage,network}` via its constructor — no reaching into wallet internals), `lsps-client`, `esplora-client`, `crypto-utils`, `state-backup` (backup envelope crypto — see below), `indexed-db-storage`, `storage-cache`. `WalletConfig` extras: `announceChannels`, `alias` (broadcast a node_announcement), `trustedZeroConfPeers`, `rapidGossipSyncUrl`. Built to CJS+ESM via `tsup`.
- **`packages/libre-nwc-push-gateway`** (`@libre/nwc-push-gateway`) — stateless Express server (`LibreNWCPushGateway`) that subscribes to Nostr relays and sends Web Push to wake offline PWAs for NWC/NIP-47 requests. SQLite-backed (`better-sqlite3`), CJS build.
- **`packages/example-app`** (`@libre/example-app`) — Vite PWA playground. `main.ts` is being slimmed into a bootstrap that wires feature modules (`web-push.ts`, `nwc-ui.ts`, `v4v.ts`, …) plus `core/` (`logger.ts`, `ui-helpers.ts`, `app-context.ts`). Pattern: mutable state (`wallet`, `isNodeRunning`) stays in `main.ts`; modules receive **live accessors** via `AppContext` (`getWallet()`, `isRunning()`) passed to `initX(ctx)`, and expose `setXEnabled()` that the start/stop handlers call (so node-control stays decoupled). The remaining handlers (node start/stop, peer-connect, lsp-capacity, receive, backup/drive, network-config, seed) are still inline in `main.ts` — extract them the same way. `core/persistent-storage.ts` (`ensurePersistentStorage()`) is the one app-layer module that may touch `navigator`. The **mainnet preset + Google Client ID read from a gitignored `.env.local`** (`VITE_MAINNET_PEER`, `VITE_MAINNET_BRIDGE`, `VITE_GOOGLE_CLIENT_ID`). `tsup.config.ts` bundles `src/service-worker.ts` into `public/` separately from the Vite build. Has its own vitest setup (`pnpm --filter @libre/example-app test`).

  **Onboarding & backup flow (seed-only):** **Create New Wallet** reveals a freshly generated seed (no hardcoded default) → user ticks "I've saved my recovery seed" → **Create Wallet** wipes storage, writes the seed, and auto-starts the node, which best-effort syncs + verifies the encrypted backup to Drive. Start refuses a generated-but-not-created wallet (no bypass). `ensurePersistentStorage()` **warns** (does not block) when storage isn't durable — `navigator.storage.persist()` returns false on ordinary localhost windows, so a hard block was a false positive; the saved seed + verified backup are the real safety net. Auto-start-on-load is default-on (persisted checkbox). Drive backups are **seed-encrypted** and auto-sync (debounced) on channel-state change, with a catch-up sync on (re)connect. Restore is seed-only. (The SDK retains the optional passphrase/dual-wrap capability; the app doesn't surface it. BIP39 word seeds are a planned follow-up.)

### Core design patterns (enforced)

- **Dependency injection / platform abstraction:** The SDK must NOT import platform modules (`fs`, `window`, React Native `SecureStore`) directly. Storage, WebSocket transport, and logging are injected as interfaces (`SecureStorageProvider`, `WebSocketStreamProvider`, `Logger`) via the wallet constructor. Web injects IndexedDB; mobile injects Keychain.
- **No stateful singletons:** Never `export const node = new LDKNode()`. Instantiate the node inside a class instance so tests can run concurrently and re-init cleanly.
- **No hardcoded env in the SDK:** All config (network, Esplora endpoint, whitelisted relays/LSPs) is passed into the constructor — no `process.env` reads inside the library.
- **Barrel exports only:** Import from package `index.ts`, not deep relative paths.
- **Errors:** No silent catches. Log via the injected `Logger` and rethrow or return `{ ok: false, error: string }`.

### V4V / boostagram TLV (keysend)

- Key `7629169`: UTF-8 JSON `BoostRecord` (bLIP-10) — **not** hex-encoded.
- Key `7629175`: Podcast Index `feedGuid` as a plain string.
- `boost_uuid` is shared across all split recipients; `uuid` is unique per-recipient. See `project-conventions.md` for the full payload schema.

### Backup format (`state-backup.ts`)

- **v2 (current) = envelope encryption.** A random 32-byte DEK encrypts the `BackupPayload` (AES-256-GCM); the DEK is wrapped to **both** a passphrase (PBKDF2-SHA256, 600k iters, random salt) and the seed (HKDF-SHA256, info `libre-wallet-backup-kek-v2`), so **either secret independently decrypts** the backup. `serializeAndEncrypt(payload, { passphrase, seedHex })` emits v2.
- **v1 (legacy) = seed-only** (HKDF info `libre-wallet-backup-v1`, AES-GCM). `serializeAndEncryptV1(payload, seedHex)` still exists; `decryptAndParse(envelope, secret)` auto-detects v1/v2. `exportState()` with no passphrase emits v1 (what the example app uses today).
- `BackupPayload.entries` holds `ldk_seed` + `channel_manager` + monitor keys + `network_graph`/`scorer`/`state_version` — i.e. the seed is *inside* the (encrypted) backup. All WebCrypto; no deps. The DB-not-namespaced-by-network gotcha means a backup's `network` is checked on import.

## Critical Guardrails

- **Absolute key isolation:** Seed phrases, private keys, and unclaimed-HTLC preimages must never leave the client sandbox — never over sockets, HTTP, or logs. Backups must be encrypted locally first.
- **Zero-custody gateway:** The push gateway must never hold node keys or NWC shared secrets; it routes blind, encrypted Nostr envelopes only.
- **DB isolation:** The gateway uses its own standalone SQLite/Postgres DB — never the host app's database.
- **Zero-conf LSP vetting:** Accept 0-conf JIT channels only from trusted LSPs. Enforced on the acceptance side via `WalletConfig.trustedZeroConfPeers` (allowlist of counterparty pubkeys); non-allowlisted peers fall through to a normal, confirmation-gated channel. Never 0-conf from random gossip nodes.
- **Localhost binding:** All docker/testing services map ports to `127.0.0.1` only.

## Known limitations & gotchas (hard-won — read before debugging "it broke")

- **Wallet storage IS namespaced by network (fixed).** Each network uses its own IndexedDB (`libre-wallet-<network>`); the example app builds a network-scoped `IndexedDBStorageProvider` (`core/storage-namespace.ts` → `dbNameForNetwork`), auto-migrates the legacy un-namespaced `libre-wallet` DB into the right network DB on first load (`migrateStorage`, idempotent, copies `ldk_seed` last for crash-safety, legacy DB left intact), and disables the network selector while the node runs. Off-page consumers (service worker, web-push simulate) read the active network from a fixed `libre-wallet-meta` pointer (`ACTIVE_NETWORK_KEY`). Historically all networks shared one DB and switching profiles corrupted channel state (`Loaded 0 channel monitors` + a wrong-chain manager) — that's resolved. Each network is an independent wallet (own seed).
- **Rapid Gossip Sync is CORS-blocked in the browser.** `rapidsync.lightningdevkit.org` sends no `Access-Control-Allow-Origin`, so the browser `fetch` fails (it only works from Node tests). The graph can't populate in-browser ⇒ **no multi-hop routing via RGS in the browser**. The example app leaves `rapidGossipSyncUrl` undefined for this reason; in-browser routing needs a CORS-enabled RGS proxy or live P2P gossip.
- **Public Esplora endpoints rate-limit.** `mempool.space` → "Failed to fetch" (CORS/Cloudflare), `blockstream.info` → `429 Too Many Requests` once a Start's burst of block-by-block sync requests (compounded by repeated Starts) trips the limit. The example app now defaults mainnet to `mempool.space/api`; don't spam Start. **Auto-start-on-load is enabled by default** (a wallet should just run) but exposed as an **"Auto-start node on load" checkbox** (persisted in `localStorage` as `libre_autostart`); untick it if public-Esplora rate limits bite on repeated reloads.
- **A browser node has no listening socket** — nothing can dial it. It connects *out* through a **websockify bridge** to a peer, and the peer opens the channel back over that existing connection. Tor-only peers need a `tor` + `socat` (SOCKS4A) + `websockify` chain.

## Testing Rules (Vitest)

- **TDD is mandatory:** red → green → refactor. No production code changes without corresponding tests in the same task.
- **Do NOT mock LDK internals** (`vi.mock('lightningdevkit')`, channel managers). Use the real LDK WASM library; mock the network socket transport or HTTP via **MSW** instead.
- **Do NOT mock the gateway DB.** Use a real isolated test DB (in-memory SQLite); truncate between suites.
- **Assert outcomes, not implementation** (node status transitions, persisted state, relay responses) — not private call order or log strings.
- Wallet tests run in `jsdom` (IndexedDB simulation); gateway tests run in `node`.
- Integration tests in `packages/libre-listener-wallet/src/tests/integration/` require the `docker compose` regtest stack (esplora on `:3002`, lnd LSP on `:9735`). Unit tests in `src/tests/unit/` do not.

## Conventions

- Files: kebab-case (`tlv-encoder.ts`). Types/interfaces: PascalCase. Variables/functions: camelCase.
- Never commit without human approval.
