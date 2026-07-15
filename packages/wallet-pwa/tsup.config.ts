import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/service-worker.ts"],
  outDir: "public",
  format: ["esm"],
  outExtension: () => ({ js: ".js" }),
  bundle: true,
  minify: false,
  sourcemap: true,
  clean: false,
  platform: "browser",
  // Everything the SW needs must be BUNDLED — a browser ServiceWorker can't resolve bare
  // specifiers. @scure/base (pulled in via nostr-tools) must be here or the SW fails to
  // evaluate ("ServiceWorker script evaluation failed").
  // @scure/bip39 is pulled in via the SDK's seed-phrase module (BIP39 recovery-phrase support);
  // it MUST be bundled or the service worker dies with "ServiceWorker script evaluation failed".
  // @libre/wallet-core: the extracted controller/core layer — any SW import of it (direct or
  // transitive) must be bundled like the SDK, or the SW dies on a bare specifier.
  noExternal: ["@libre/listener-wallet", "@libre/shared", "@libre/wallet-core", "lightningdevkit", "nostr-tools", "zod", "@scure/base", "@scure/bip39"],
  external: ["crypto"]
});
