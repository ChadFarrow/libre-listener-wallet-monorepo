// Bundle smoke test — the same class of guard as the PWA's service-worker sandbox eval: the
// shipped artifact must be SELF-CONTAINED (no bare import specifiers survive tsup's noExternal),
// because a host page can't resolve workspace package names. Skips when dist/ hasn't been built.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(__dirname, "..", "dist");

describe("built bundles are self-contained", () => {
  it.skipIf(!existsSync(join(dist, "index.mjs")))("ESM lib has no bare workspace/lib imports", () => {
    const src = readFileSync(join(dist, "index.mjs"), "utf8");
    for (const dep of ["@libre/wallet-core", "@libre/listener-wallet", "@libre/shared", "lightningdevkit", "nostr-tools", "@scure/"]) {
      expect(src.includes(`from "${dep}`), `bare specifier survived: ${dep}`).toBe(false);
      expect(src.includes(`from '${dep}`), `bare specifier survived: ${dep}`).toBe(false);
    }
  });

  it.skipIf(!existsSync(join(dist, "libre-wallet.global.js")))("IIFE build contains no import statements at all", () => {
    const src = readFileSync(join(dist, "libre-wallet.global.js"), "utf8");
    expect(/^\s*import\s/m.test(src)).toBe(false);
  });

  it.skipIf(!existsSync(dist))("the WASM binary ships in dist", () => {
    expect(existsSync(join(dist, "liblightningjs.wasm"))).toBe(true);
  });
});
