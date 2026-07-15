import { describe, it, expect, vi } from "vitest";
import { createPwaLeaseKeeper, leaseHolderBlockingStart, type PwaLeaseIo } from "./pwa-lease";
import type { RoamingLeaseRecord, WalletControllerApi } from "@libre/wallet-core";
import { leaseFilename } from "@libre/wallet-core";

const NOW = Date.now();

function liveLease(over: Partial<RoamingLeaseRecord> = {}): RoamingLeaseRecord {
  return {
    v: 1,
    owner: "tok-embed",
    origin: "https://boostmebitch.vercel.app",
    acquiredAt: NOW - 10_000,
    expiresAt: NOW + 60_000,
    seq: 2,
    heartbeatStateVersion: 10,
    phase: "live",
    ...over,
  };
}

function fakeIo(initialLease: RoamingLeaseRecord | null = null) {
  const files = new Map<string, string>();
  if (initialLease) files.set(leaseFilename("mainnet"), JSON.stringify(initialLease));
  const local = new Map<string, string>([["state_version", "12"], ["ldk_seed", "aa".repeat(32)]]);
  const io: PwaLeaseIo = {
    readFile: async (name) => (files.has(name) ? { contents: files.get(name)!, modifiedTime: "" } : null),
    writeFile: async (name, contents) => void files.set(name, contents),
    downloadBackup: async () => null,
    uploadBackup: vi.fn(async () => {}),
    storageGet: async (_n, key) => local.get(key) ?? null,
  };
  return { io, files, local };
}

function fakeController(over: Partial<Record<string, unknown>> = {}) {
  let running = true;
  return {
    isRunning: () => running,
    getState: async () => ({ network: "mainnet" }),
    stopNode: vi.fn(async () => {
      running = false;
    }),
    exportBackup: vi.fn(async () => "envelope-bytes"),
    _setRunning: (v: boolean) => (running = v),
    ...over,
  } as unknown as WalletControllerApi & { _setRunning: (v: boolean) => void; stopNode: ReturnType<typeof vi.fn> };
}

describe("leaseHolderBlockingStart", () => {
  it("blocks a guarded start only on a LIVE foreign lease with Drive connected", async () => {
    const { io } = fakeIo(liveLease());
    expect(await leaseHolderBlockingStart("mainnet", true, io)).toBe("https://boostmebitch.vercel.app");
    // Drive offline → never blocks (the PWA's offline-first start behavior)
    expect(await leaseHolderBlockingStart("mainnet", false, io)).toBeNull();
    // Expired lease → free to start
    const { io: io2 } = fakeIo(liveLease({ expiresAt: NOW - 1 }));
    expect(await leaseHolderBlockingStart("mainnet", true, io2)).toBeNull();
    // Released lease → free
    const { io: io3 } = fakeIo(liveLease({ phase: "released" }));
    expect(await leaseHolderBlockingStart("mainnet", true, io3)).toBeNull();
    // Unreachable lease file → never blocks
    const broken: PwaLeaseIo = { ...io, readFile: async () => Promise.reject(new Error("down")) };
    expect(await leaseHolderBlockingStart("mainnet", true, broken)).toBeNull();
  });
});

describe("createPwaLeaseKeeper", () => {
  it("claims the lease when running with Drive connected, releases on stop", async () => {
    const { io, files } = fakeIo();
    const controller = fakeController();
    const keeper = createPwaLeaseKeeper({
      controller,
      driveConnected: () => true,
      origin: "https://libre-wallet-pwa.pages.dev",
      io,
      leaseTuning: { delay: async () => {} },
    });
    keeper.onEvent();
    await vi.waitFor(() => {
      const rec = JSON.parse(files.get(leaseFilename("mainnet")) ?? "{}");
      expect(rec.origin).toBe("https://libre-wallet-pwa.pages.dev");
      expect(rec.phase).toBe("live");
      expect(rec.heartbeatStateVersion).toBe(12);
    });
    controller._setRunning(false);
    keeper.onEvent();
    await vi.waitFor(() => {
      const rec = JSON.parse(files.get(leaseFilename("mainnet"))!);
      expect(rec.phase).toBe("released");
    });
  });

  it("self-fences when already running against a LIVE foreign lease (auto-start race): stop, flush-if-ahead, ack", async () => {
    const { io, files } = fakeIo(liveLease({ heartbeatStateVersion: 10 }));
    const controller = fakeController();
    const onMoved = vi.fn();
    const keeper = createPwaLeaseKeeper({
      controller,
      driveConnected: () => true,
      origin: "https://libre-wallet-pwa.pages.dev",
      onMoved,
      io,
    });
    keeper.onEvent();
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledWith("https://boostmebitch.vercel.app"));
    expect(controller.stopNode).toHaveBeenCalled();
    // local v12 vs Drive backup absent (v0) → flushed
    expect(io.uploadBackup).toHaveBeenCalledWith("envelope-bytes", "mainnet");
    const rec = JSON.parse(files.get(leaseFilename("mainnet"))!);
    expect(rec.owner).toBe("tok-embed"); // never touched the embed's ownership
    expect(rec.handoffAck).toMatchObject({ flushedVersion: 12 });
  });

  it("does nothing in demo mode or while Drive is disconnected", async () => {
    const { io, files } = fakeIo();
    const controller = fakeController();
    createPwaLeaseKeeper({ controller, driveConnected: () => false, io }).onEvent();
    createPwaLeaseKeeper({ controller, driveConnected: () => true, isDemo: () => true, io }).onEvent();
    await new Promise((r) => setTimeout(r, 30));
    expect(files.size).toBe(0);
  });
});
