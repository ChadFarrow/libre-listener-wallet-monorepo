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
- **`packages/libre-listener-wallet`** (`@libre/listener-wallet`) — the client SDK. The `LibreListenerWallet` class (`src/index.ts`) adapts LDK's low-level bindings into a simple API (`start()`, `sendPayment()`, `getBalance()`, etc.). Supporting modules: `nwc-manager`, `lsps-client`, `esplora-client`, `indexed-db-storage`, `storage-cache`. Built to CJS+ESM via `tsup`.
- **`packages/libre-nwc-push-gateway`** (`@libre/nwc-push-gateway`) — stateless Express server (`LibreNWCPushGateway`) that subscribes to Nostr relays and sends Web Push to wake offline PWAs for NWC/NIP-47 requests. SQLite-backed (`better-sqlite3`), CJS build.
- **`packages/example-app`** (`@libre/example-app`) — Vite PWA demo. Note its `tsup.config.ts` bundles `src/service-worker.ts` into `public/` separately from the Vite app build.

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

## Critical Guardrails

- **Absolute key isolation:** Seed phrases, private keys, and unclaimed-HTLC preimages must never leave the client sandbox — never over sockets, HTTP, or logs. Backups must be encrypted locally first.
- **Zero-custody gateway:** The push gateway must never hold node keys or NWC shared secrets; it routes blind, encrypted Nostr envelopes only.
- **DB isolation:** The gateway uses its own standalone SQLite/Postgres DB — never the host app's database.
- **Zero-conf LSP vetting:** Request 0-conf JIT channels only from LSPs in the curated `.well-known` registry; never from random gossip nodes.
- **Localhost binding:** All docker/testing services map ports to `127.0.0.1` only.

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
