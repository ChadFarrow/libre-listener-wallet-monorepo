# `@libre/shared`

Common TypeScript types, interfaces, validation schemas, and calculation utilities shared across the **Libre Listener Wallet** workspaces.

---

## Package Overview

This package acts as the single source of truth for schemas, types, and logic boundaries between the client-side wallet SDK (`@libre/listener-wallet`) and the server-side notifications gateway daemon (`@libre/nwc-push-gateway`).

### Key Modules

1. **JSON-RPC & LSPS Schemas (`src/index.ts`)**:
   * Interfaces for LSP configuration (`LspProvider`), LSPS1 Order flows (`Lsps1GetInfoResponse`, `Lsps1CreateOrderParams`), and LSPS2 JIT Channel negotiations.
   * Universal wallet configuration definitions (`WalletConfig`).

2. **Nostr Wallet Connect validation (`src/nwc-schema.ts`)**:
   * Zod validation schemas for NWC query payloads (`makeInvoiceParamsSchema`, `payInvoiceParamsSchema`, `payKeysendParamsSchema`).
   * Zod discriminated union schema `nwcRequestSchema` to parse and validate incoming JSON-RPC commands before executing them against the local LDK node.
   * Pairing connection metadata interface (`NwcConnection`).

3. **Value-for-Value Splits & TLV Encoding (`src/v4v-utils.ts`)**:
   * Spontaneous Keysend metadata splits logic (`calculateSplits()`), which splits custom streaming payments or one-off "boostagrams" across multiple recipients (e.g. 90% creator, 10% publisher) using the same `boost_uuid` to group split transactions.
   * Custom TLV (Type-Length-Value) record encoders (`encodeV4VTlvs()`) to pack bLIP-10 podcast metadata (JSON string on key `7629169`) and podcast index IDs (key `7629175`) into LDK compatible byte buffers.

---

## Build & Test

This workspace compiles to CommonJS (CJS) and ES Modules (ESM) using `tsup`.

```bash
# Compile package
pnpm build

# Run linting
pnpm lint
```
