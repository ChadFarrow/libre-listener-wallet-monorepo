import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { IndexedDBStorageProvider } from "@libre/listener-wallet";
import { dbNameForNetwork } from "@libre/wallet-core";
import type { PaymentRecord } from "@libre/shared";
import { mountLibreWallet } from "./index";

describe("mountLibreWallet transactions API", () => {
  it("getTransactions returns the stored log mapped to TxView — newest-first, no preimage", async () => {
    // Seed the SDK payment log directly (getPayments reads tx_* from storage even when stopped).
    // A stopped controller resolves its network from the meta pointer, which defaults to mainnet —
    // the network the embed ships — so seed that DB and mount with the default network.
    const storage = new IndexedDBStorageProvider(dbNameForNetwork("mainnet"));
    const older: PaymentRecord = {
      id: "a",
      direction: "received",
      status: "settled",
      amountSats: 100,
      timestamp: 100,
      preimage: "aa",
    };
    const newer: PaymentRecord = {
      id: "b",
      direction: "sent",
      status: "settled",
      amountSats: 40,
      feeSats: 1,
      timestamp: 300,
      preimage: "bb",
      note: "Boost",
    };
    await storage.setItem("tx_a", JSON.stringify(older));
    await storage.setItem("tx_b", JSON.stringify(newer));

    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = mountLibreWallet(host, { googleClientId: "cid", wasmUrl: "/w.wasm" });

    const txs = await handle.getTransactions();
    expect(txs.map((t) => t.id)).toEqual(["b", "a"]); // newest-first
    expect(txs[0]).toMatchObject({ id: "b", direction: "sent", amountSats: 40, note: "Boost" });
    expect(txs.some((t) => "preimage" in t)).toBe(false);

    await handle.dispose();
  });

  it("onTransaction registers a listener and returns an unsubscribe fn", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = mountLibreWallet(host, { googleClientId: "cid", wasmUrl: "/w.wasm", network: "regtest" });

    const unsub = handle.onTransaction(() => {});
    expect(typeof unsub).toBe("function");
    unsub(); // must not throw

    await handle.dispose();
  });
});
