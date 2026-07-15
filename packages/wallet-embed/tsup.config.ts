import { defineConfig } from "tsup";

// The published artifact must be SELF-CONTAINED: the workspace packages it depends on are not on
// npm, so every dependency — including the LDK bindings — is bundled (`noExternal`). Same rule as
// the PWA service-worker build: no bare specifier may survive into the output (the bundle-eval
// smoke test pins this). The WASM binary is copied into dist/ by scripts/copy-wasm.mjs; consumers
// serve it themselves and pass its URL as `wasmUrl`.
const noExternal = [
  "@libre/wallet-core",
  "@libre/listener-wallet",
  "@libre/shared",
  "lightningdevkit",
  "nostr-tools",
  "zod",
  "@scure/base",
  "@scure/bip39",
  "@noble/curves",
  "@noble/hashes",
];

export default defineConfig([
  {
    // Library build (npm/tarball consumers — e.g. the boostmebitch Next.js import)
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    platform: "browser",
    noExternal,
    external: ["crypto"],
  },
  {
    // Script-tag build: <script src="libre-wallet.js"> exposes window.LibreWallet
    entry: { "libre-wallet": "src/script-entry.ts" },
    format: ["iife"],
    globalName: "LibreWallet",
    sourcemap: true,
    platform: "browser",
    noExternal,
    // An IIFE can't leave "crypto" external (no import mechanism) — alias it to the shim; the
    // bindings only touch it in a browser-unreachable typeof-guard fallback.
    esbuildOptions(options) {
      options.alias = { ...(options.alias ?? {}), crypto: "./src/crypto-shim.ts" };
    },
  },
]);
