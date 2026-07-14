import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nativeShareAvailable, nativeShareText } from "./native-share";

const g = globalThis as unknown as {
  __LIBRE_NATIVE__?: boolean;
  Capacitor?: unknown;
};

interface Recorded {
  shares: Array<{ title?: string; text?: string; files?: string[] }>;
  writes: Array<{ path: string; data: string; directory: string; encoding: string }>;
}

function installPlugins(opts: { filesystem?: boolean; share?: boolean } = {}): Recorded {
  const rec: Recorded = { shares: [], writes: [] };
  const Plugins: Record<string, unknown> = {};
  if (opts.share !== false) {
    Plugins.Share = {
      share: async (o: { title?: string; text?: string; files?: string[] }) => {
        rec.shares.push({ title: o.title, text: o.text, files: o.files });
        return { activityType: "test" };
      },
    };
  }
  if (opts.filesystem !== false) {
    Plugins.Filesystem = {
      writeFile: async (o: { path: string; data: string; directory: string; encoding: string }) => {
        rec.writes.push(o);
        return { uri: `file:///cache/${o.path}` };
      },
    };
  }
  g.__LIBRE_NATIVE__ = true;
  g.Capacitor = { Plugins };
  return rec;
}

function clearAll() {
  delete g.__LIBRE_NATIVE__;
  delete g.Capacitor;
}

describe("nativeShareAvailable", () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  it("is false in a plain browser (no native, no Share plugin)", () => {
    expect(nativeShareAvailable()).toBe(false);
  });

  it("is false when native but the Share plugin is not registered", () => {
    installPlugins({ share: false });
    expect(nativeShareAvailable()).toBe(false);
  });

  it("is true when native + the Share plugin is registered", () => {
    installPlugins();
    expect(nativeShareAvailable()).toBe(true);
  });
});

describe("nativeShareText", () => {
  beforeEach(clearAll);
  afterEach(clearAll);

  it("writes the log to a cache file and shares it AS A FILE (no truncation)", async () => {
    const rec = installPlugins();
    await nativeShareText("libre-diag-mainnet-2026-07-13-1200.txt", "LOG DATA");
    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0].path).toBe("libre-diag-mainnet-2026-07-13-1200.txt");
    expect(rec.writes[0].data).toBe("LOG DATA");
    expect(rec.writes[0].directory).toBe("CACHE");
    expect(rec.shares).toHaveLength(1);
    expect(rec.shares[0].files).toEqual(["file:///cache/libre-diag-mainnet-2026-07-13-1200.txt"]);
    // sharing a file, not inline text (which some receivers truncate)
    expect(rec.shares[0].text).toBeUndefined();
  });

  it("falls back to inline text sharing when Filesystem is unavailable", async () => {
    const rec = installPlugins({ filesystem: false });
    await nativeShareText("d.txt", "SHORT LOG");
    expect(rec.writes).toHaveLength(0);
    expect(rec.shares).toHaveLength(1);
    expect(rec.shares[0].text).toBe("SHORT LOG");
    expect(rec.shares[0].files).toBeUndefined();
  });

  it("throws when the Share plugin is unavailable", async () => {
    installPlugins({ share: false });
    await expect(nativeShareText("d.txt", "X")).rejects.toThrow();
  });
});
