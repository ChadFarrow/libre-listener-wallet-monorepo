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
  noExternal: ["@libre/listener-wallet", "@libre/shared", "lightningdevkit", "nostr-tools", "zod", "@scure/base"],
  external: ["crypto"]
});
