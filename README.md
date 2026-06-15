# Libre Listener Wallet Monorepo

> [!WARNING]
> **Active Development**: This project is in active development and is **not yet functional**. Do not attempt to run this in production.

> [!CAUTION]
> **Experimental Software**: This software is experimental. **Loss of Bitcoin is highly likely.** Use at your own risk.

---

The **Libre Listener Wallet** is a zero-infrastructure, non-custodial Bitcoin Lightning Network implementation. It is designed to run directly inside browser/PWA sandboxes and native mobile wrappers, bringing friction-free Lightning payments to the Podcasting 2.0 and Value-for-Value (`v4vmusic.com`) music streaming ecosystem.

## Workspace Packages

The repository is structured as a TypeScript monorepo managed by `pnpm` and Turborepo:

*   **[`packages/shared`](ai/prompts/primer-prompt.md)**: Common types, request schemas, and serializations shared between the SDK and push gateway.
*   **[`packages/libre-listener-wallet`](ai/prompts/primer-prompt.md)**: The client-side SDK wrapping LDK (Lightning Development Kit) WASM and native C/Rust bindings.
*   **[`packages/libre-nwc-push-gateway`](ai/prompts/primer-prompt.md)**: The server-side, stateless notification gateway used to wake up offline PWAs for Nostr Wallet Connect (NWC) requests.

---

## Developer & AI Agent Orientation

If you are a developer or an AI coding assistant working on this codebase:
*   Read the project contracts and design roadmap located in the [**`ai/`**](ai/prompts/primer-prompt.md) directory.
*   Refer to the [**`ai/prompts/primer-prompt.md`**](ai/prompts/primer-prompt.md) onboarding prompt to understand critical security constraints, port configurations, and testing rules.

---

## Quick Start

### 1. Build and Compile Workspaces
Installs dependencies and runs the compiler pipelines (`tsup`) to build code targets:
```bash
pnpm install
pnpm build
```

### 2. Run Test Suites
Executes Vitest tests across all packages:
```bash
pnpm test
```

### 3. Spin Up Local Regtest Sandbox
Runs local integration testing services (`bitcoind`, `electrs` indexer, `lnd` mock LSP, and `websockify` TCP bridge proxy):
```bash
docker compose up -d
```
All ports are bound strictly to `127.0.0.1` for local safety.
