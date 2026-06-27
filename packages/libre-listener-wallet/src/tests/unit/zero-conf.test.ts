import { describe, it, expect } from "vitest";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider } from "../../index";

// The 0-conf trust gate is a pure decision over WalletConfig — no LDK/WASM needed,
// so we exercise it directly on a freshly-constructed wallet.
const noopStorage: SecureStorageProvider = {
  getItem: async () => null,
  setItem: async () => {},
  removeItem: async () => {},
};
const noopSocket: WebSocketStreamProvider = { connect: async () => { throw new Error("unused"); } };

function makeWallet(trustedZeroConfPeers?: string[]) {
  return new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: "http://127.0.0.1:3002", trustedZeroConfPeers },
    storage: noopStorage,
    socketProvider: noopSocket,
  });
}

const TRUSTED = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("0-conf trust gating", () => {
  it("permits 0-conf only for peers in trustedZeroConfPeers", () => {
    const wallet = makeWallet([TRUSTED]);
    expect(wallet["isZeroConfTrusted"](TRUSTED)).toBe(true);
    expect(wallet["isZeroConfTrusted"](OTHER)).toBe(false);
  });

  it("never permits 0-conf when trustedZeroConfPeers is unset", () => {
    const wallet = makeWallet();
    expect(wallet["isZeroConfTrusted"](TRUSTED)).toBe(false);
    expect(wallet["isZeroConfTrusted"](OTHER)).toBe(false);
  });
});
