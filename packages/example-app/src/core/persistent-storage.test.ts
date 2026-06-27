// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { ensurePersistentStorage } from "./persistent-storage";

describe("ensurePersistentStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when the Storage API is unavailable (incognito-like)", async () => {
    vi.stubGlobal("navigator", {});
    expect(await ensurePersistentStorage()).toBe(false);
  });

  it("returns true when storage is already persisted", async () => {
    vi.stubGlobal("navigator", { storage: { persisted: async () => true, persist: async () => false } });
    expect(await ensurePersistentStorage()).toBe(true);
  });

  it("requests persistence when not yet persisted and succeeds", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persisted: async () => false, persist } });
    expect(await ensurePersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("returns false when persistence is denied", async () => {
    vi.stubGlobal("navigator", { storage: { persisted: async () => false, persist: async () => false } });
    expect(await ensurePersistentStorage()).toBe(false);
  });
});
