import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup";
import { calculateSplits, encodeV4VTlvs } from "@libre/shared";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider, WebSocketConnection } from "../../index";
import * as fs from "fs";
import * as path from "path";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../../../node_modules/.pnpm/node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p);
    }
  }
  throw new Error("Could not find liblightningjs.wasm");
}

describe("Value-for-Value Shared Utils", () => {
  it("should calculate splits correctly and distribute remainders to the last element", () => {
    const destinations = [
      { destinationPubkey: "pubkey1", share: 33 },
      { destinationPubkey: "pubkey2", share: 33 },
      { destinationPubkey: "pubkey3", share: 33 },
    ];

    const splits = calculateSplits({
      destinations,
      amountSats: 100,
      boostRecordTemplate: {
        action: "boost",
        app_name: "test-app",
      },
      feedGuid: "podcast-feed-guid",
    });

    expect(splits).toHaveLength(3);
    expect(splits[0].amountSats).toBe(33);
    expect(splits[1].amountSats).toBe(33);
    expect(splits[2].amountSats).toBe(34); // Remainder allocated to last element

    const totalCalculated = splits.reduce((sum, s) => sum + s.amountSats, 0);
    expect(totalCalculated).toBe(100);

    // Verify UUIDs
    const boostUuid = splits[0].boostRecord.boost_uuid;
    expect(boostUuid).toBeDefined();
    expect(splits[1].boostRecord.boost_uuid).toBe(boostUuid);
    expect(splits[2].boostRecord.boost_uuid).toBe(boostUuid);

    expect(splits[0].boostRecord.uuid).not.toBe(splits[1].boostRecord.uuid);
    expect(splits[0].boostRecord.value_msat_total).toBe(100000);
  });

  it("should encode TLVs in ascending sorted key order", () => {
    const boostRecord = {
      action: "boost" as const,
      value_msat_total: 100000,
      app_name: "test-app",
      boost_uuid: "shared-uuid",
      uuid: "unique-uuid",
    };

    const tlvs = encodeV4VTlvs({
      boostRecord,
      feedGuid: "podcast-feed-guid",
      customKey: 1337,
      customValue: "custom-value",
    });

    // Keys:
    // - Custom key: 1337
    // - Boost record JSON: 7629169
    // - Feed GUID: 7629175
    // Sorted ascending: 1337, 7629169, 7629175
    expect(tlvs).toHaveLength(3);
    expect(tlvs[0].key).toBe(1337);
    expect(tlvs[1].key).toBe(7629169);
    expect(tlvs[2].key).toBe(7629175);

    const decodedBoost = JSON.parse(new TextDecoder().decode(tlvs[1].value));
    expect(decodedBoost.app_name).toBe("test-app");
    expect(new TextDecoder().decode(tlvs[2].value)).toBe("podcast-feed-guid");
  });
});

describe("sendKeysendPayment LDK Integration", () => {
  const ESPLORA = "http://127.0.0.1:3002";
  // A fresh node built at tip height 0 makes the initial sync a no-op, so start()
  // needs only these three esplora reads mocked — no docker/regtest required.
  beforeEach(() => {
    server.use(
      http.get(`${ESPLORA}/fee-estimates`, () => HttpResponse.json({})),
      http.get(`${ESPLORA}/blocks/tip/height`, () => HttpResponse.text("0")),
      http.get(`${ESPLORA}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
    );
  });

  const mockStorage: SecureStorageProvider = {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };

  const mockSocketProvider: WebSocketStreamProvider = {
    connect: async () =>
      ({
        send: () => {},
        close: () => {},
      } as unknown as WebSocketConnection),
  };

  it("should attempt a keysend and return ok=false since no channels exist", async () => {
    const wallet = new LibreListenerWallet({
      config: {
        network: "regtest",
        esploraUrl: "http://127.0.0.1:3002",
      },
      storage: mockStorage,
      socketProvider: mockSocketProvider,
      wasmBinary: loadWasmBinary(),
    });

    await wallet.start();

    const destPubkey = "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24";
    const res = await wallet.sendKeysendPayment({
      destinationPubkey: destPubkey,
      amountSats: 1000,
      customRecords: {
        7629175: "podcast-feed-guid",
      },
    });

    // Should return false with LDK route/channel failure message instead of throwing an unhandled crash
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeDefined();
      expect(res.error).toContain("Payment failed to initiate");
    }

    await wallet.stop();
  });
});
