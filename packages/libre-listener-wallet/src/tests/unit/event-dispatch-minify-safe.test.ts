// @vitest-environment node
//
// Regression guard for a PROD-ONLY trap. The deployed PWA is minified (Vite/esbuild),
// which mangles the LDK binding class names — `Event_OpenChannelRequest` becomes e.g.
// "Fzt" at runtime. So dispatching on `event.constructor.name === "Event_..."` silently
// fails in production: NO event handler runs, so an inbound channel open is received but
// never accepted, payments are never claimed, and the force-close sweeper never fires.
// It works in `pnpm dev` (unminified), so a normal unit test can't reproduce it — hence
// we guard the source directly. Events MUST be dispatched with `instanceof <Event_ class>`,
// which compares the imported class reference and survives minification.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexSrc = readFileSync(fileURLToPath(new URL("../../index.ts", import.meta.url)), "utf8");

describe("LDK event dispatch is minification-safe", () => {
  it("never dispatches by comparing event.constructor.name to an Event_* string", () => {
    // e.g. `name === "Event_OpenChannelRequest"` — the exact bug that broke channel
    // acceptance on the deployed PWA. Use `event instanceof Event_OpenChannelRequest`.
    const offenders = indexSrc.match(/===\s*["']Event_[A-Za-z]+["']/g) ?? [];
    expect(offenders).toEqual([]);
  });

  it("dispatches inbound channel opens via instanceof", () => {
    expect(indexSrc).toMatch(/event\s+instanceof\s+Event_OpenChannelRequest/);
  });
});
