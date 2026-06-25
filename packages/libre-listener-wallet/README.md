# `@libre/listener-wallet`

The client-side SDK wrapping **LDK (Lightning Development Kit) WebAssembly (WASM)**. It manages peer connections, channel states, payments, and Nostr Wallet Connect (NWC) protocol listeners inside browser and PWA sandboxes.

---

## Features

* **Zero-Custody Seed Isolation**: Private keys are generated and stored exclusively within the local execution environment.
* **Portable State Sharing**: Employs `IndexedDBStorageProvider` to share LDK node configurations, seed secrets, and channel monitors between the foreground web app and a background browser Service Worker.
* **Network Agnostic Client**: Communicates with the blockchain using the HTTP-based **Esplora API** (such as Blockstream or custom Electrs instances).
* **Dependency Injection Design**: Port-specific behaviors (WebSockets, key storage, logger streams) are injected upon initialization to guarantee portability.
* **Multi-Tier Liquidity Engine**:
  * *Tier 1 (LSPS2 JIT Channel)*: Onboards brand new users with a `0 sat` balance by requesting LSP-funded zero-confirmation channels.
  * *Tier 2 (LSPS1 Capacity)*: Leases inbound capacity from whitelisted providers via HTTPS APIs.
  * *Tier 3 (BOLT 2 Gossip Ads)*: Syncs network graphs rapidly (Rapid Gossip Sync) to buy protocol-native leases on the open gossip mesh.
* **bLIP-10 V4V Metadata Support**: spontaneous Keysend payments equipped with custom TLV record encoders (key `7629169` for Boostagrams and `7629175` for Guid IDs) to stream micropayments.

---

## API Quickstart

### 1. Initialize and Start Node

```typescript
import { LibreListenerWallet, IndexedDBStorageProvider } from "@libre/listener-wallet";

// Create storage instance (works in both Window & Service Worker)
const storage = new IndexedDBStorageProvider();

const wallet = new LibreListenerWallet({
  config: {
    network: "regtest",
    esploraUrl: "http://127.0.0.1:3002",
  },
  storage,
  socketProvider: myWebSocketStreamProvider, // Inject WebSocket connector
  wasmUrl: "/liblightningjs.wasm",
  logger: myCustomLogger
});

// Starts LDK WASM compilation, loads state, runs chain sync, and boots NWC
await wallet.start();
```

### 2. Request JIT Invoice (LSPS2 Onboarding)

```typescript
const invoice = await wallet.requestLSPS2Invoice({
  amountSats: 20000,
  description: "Bootstrap onboarding",
  lsp: myWhitelistedLspProvider
});
```

---

## Build & Test

The package uses Vitest for testing. The tests execute against the actual LDK WASM library to prevent over-mocking bugs.

```bash
# Compile library to ESM and CommonJS
pnpm build

# Run unit and integration tests (requires local regtest Docker sandbox)
pnpm test
```
