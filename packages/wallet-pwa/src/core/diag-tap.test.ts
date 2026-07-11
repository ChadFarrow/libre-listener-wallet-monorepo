import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { installDiagTap, diagExportText, diagClear, diagFlushNow, diagStats } from "./diag-tap";
import { deleteDiagDb } from "./diag-store";

describe("diag tap", () => {
  beforeEach(async () => {
    await deleteDiagDb();
    installDiagTap(); // idempotent — repeated installs must not double-wrap
    installDiagTap();
    await diagClear();
  });

  it("records console lines while still calling the original console through", async () => {
    console.log("[Test] hello", 42);
    console.warn("[Test] careful");
    console.error("[Test] boom");
    await diagFlushNow();
    const text = await diagExportText();
    expect(text).toContain("LOG [Test] hello 42");
    expect(text).toContain("WARN [Test] careful");
    expect(text).toContain("ERROR [Test] boom");
    // No double-recording despite installDiagTap() running twice:
    expect(text.match(/\[Test\] hello 42/g)).toHaveLength(1);
  });

  it("drops LDK [TRACE] lines", async () => {
    console.log("[LDK] [TRACE] noisy line");
    await diagFlushNow();
    expect(await diagExportText()).not.toContain("noisy line");
  });

  it("records lifecycle events on visibilitychange", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    // hidden → immediate flush; give the microtask queue a beat
    await new Promise((r) => setTimeout(r, 0));
    const text = await diagExportText();
    expect(text).toContain("EVENT visibilitychange hidden");
  });

  it("captures unhandled errors as ERROR entries", async () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "kaboom" }));
    await diagFlushNow();
    expect(await diagExportText()).toContain("ERROR uncaught: kaboom");
  });

  it("stats reports count and approximate bytes", async () => {
    console.log("[Test] sized");
    await diagFlushNow();
    const s = await diagStats();
    expect(s.count).toBeGreaterThan(0);
    expect(s.bytes).toBeGreaterThan(0);
  });

  it("clear empties everything", async () => {
    console.log("[Test] gone");
    await diagFlushNow();
    await diagClear();
    expect((await diagStats()).count).toBe(0);
    expect(await diagExportText()).toBe("");
  });
});
