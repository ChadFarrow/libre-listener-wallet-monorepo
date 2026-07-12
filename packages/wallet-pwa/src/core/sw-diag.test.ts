import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { swDiag } from "./sw-diag";
import { DiagStore, deleteDiagDb } from "./diag-store";

describe("swDiag", () => {
  beforeEach(async () => {
    await deleteDiagDb();
  });

  it("writes a [SW]-prefixed line into the shared diagnostics DB", async () => {
    await swDiag("log", "Push received: boost", 1000);
    const entries = await new DiagStore().readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ at: 1000, level: "log", msg: "[SW] Push received: boost" });
  });

  it("appends alongside main-thread entries (shared store, autoIncrement keys)", async () => {
    const store = new DiagStore();
    await store.append([{ at: 500, level: "log", msg: "main-thread line" }], 4000);
    await swDiag("error", "push parse failed", 900);
    const msgs = (await store.readAll()).map((e) => e.msg);
    expect(msgs).toContain("main-thread line");
    expect(msgs).toContain("[SW] push parse failed");
  });

  it("truncates an over-long line instead of storing megabytes", async () => {
    await swDiag("log", "x".repeat(5000), 1);
    const [entry] = await new DiagStore().readAll();
    expect(entry.msg.startsWith("[SW] ")).toBe(true);
    expect(entry.msg).toContain("…[+");
    expect(entry.msg.length).toBeLessThan(2100);
  });
});
