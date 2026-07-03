import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Offscreen documents are the most API-restricted MV3 context: they can ONLY use chrome.runtime
// (messaging + getURL). chrome.storage is UNDEFINED there — a read doesn't fail a permission
// check, it throws TypeError on the spot. This bit us live: WalletHost.autoStart() read the
// auto-start flag via chromeKV (chrome.storage.local) as its first statement, so the whole boot
// auto-start silently died inside its own catch on every launch. Anything the offscreen host
// needs from chrome.storage must be read by the BACKGROUND and passed in (see the autoStart RPC).
//
// Source-level guard (same approach as the SDK's event-dispatch-minify-safe test): a runtime unit
// test can't catch this because vitest's node env has no chrome object at all.

const OFFSCREEN_DIR = join(__dirname);

const sourceFiles = readdirSync(OFFSCREEN_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

// Mentioning an API in a comment is fine — only code counts.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("offscreen context uses only chrome.runtime APIs", () => {
  it("finds the offscreen sources", () => {
    expect(sourceFiles).toContain("wallet-host.ts");
    expect(sourceFiles).toContain("offscreen.ts");
  });

  for (const file of sourceFiles) {
    it(`${file} does not touch chrome.storage (undefined in offscreen documents)`, () => {
      const src = stripComments(readFileSync(join(OFFSCREEN_DIR, file), "utf8"));
      expect(src).not.toMatch(/chrome\.storage/);
      // chromeKV wraps chrome.storage.local — importing it into this context is the same bug.
      expect(src).not.toMatch(/chrome-kv/);
    });

    it(`${file} does not use non-runtime chrome APIs (downloads, offscreen, identity, windows, tabs)`, () => {
      const src = stripComments(readFileSync(join(OFFSCREEN_DIR, file), "utf8"));
      const uses = [...src.matchAll(/chrome\.(\w+)/g)].map((m) => m[1]);
      const disallowed = uses.filter((api) => api !== "runtime");
      expect(disallowed).toEqual([]);
    });
  }
});
