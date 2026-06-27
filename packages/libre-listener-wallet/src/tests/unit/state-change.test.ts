import { describe, it, expect } from "vitest";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider } from "../../index";

// onStateChanged + the version bump are pure (no LDK/WASM), so test on a bare wallet.
const mem: Record<string, string> = {};
const storage: SecureStorageProvider = {
  getItem: async (k) => mem[k] ?? null,
  setItem: async (k, v) => { mem[k] = v; },
  removeItem: async (k) => { delete mem[k]; },
};
const noopSocket: WebSocketStreamProvider = { connect: async () => { throw new Error("unused"); } };

function makeWallet() {
  return new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002" },
    storage,
    socketProvider: noopSocket,
  });
}

describe("onStateChanged", () => {
  it("notifies subscribers and bumps the state version on a state change", () => {
    const wallet = makeWallet();
    let fired = 0;
    wallet.onStateChanged(() => { fired++; });
    const before = wallet.getStateVersion();
    wallet["notifyStateChanged"]();
    expect(fired).toBe(1);
    expect(wallet.getStateVersion()).toBe(before + 1);
  });

  it("isolates a throwing subscriber so others still run", () => {
    const wallet = makeWallet();
    let good = 0;
    wallet.onStateChanged(() => { throw new Error("bad subscriber"); });
    wallet.onStateChanged(() => { good++; });
    wallet["notifyStateChanged"]();
    expect(good).toBe(1);
  });
});
