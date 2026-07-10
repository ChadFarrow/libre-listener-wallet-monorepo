import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup";
import {
  LibreListenerWallet,
  PaymentTimeoutError,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
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
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  throw new Error("Could not find liblightningjs.wasm");
}

// BOLT11 spec test vector: a valid mainnet donation invoice with NO amount field.
const ZERO_AMOUNT_INVOICE =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";

// In-memory storage that records every key written, so tests can assert no tx_* record
// was persisted for rejected sends.
function memStorage(seed: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(seed));
  const writes: string[] = [];
  const storage: SecureStorageProvider = {
    getItem: async (k: string) => data.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      writes.push(k);
      data.set(k, v);
    },
    removeItem: async (k: string) => {
      data.delete(k);
    },
  };
  return { storage, writes, data };
}

const mockSocketProvider: WebSocketStreamProvider = {
  connect: async () =>
    ({
      send: () => {},
      close: () => {},
    } as unknown as WebSocketConnection),
};

const ESPLORA = "http://127.0.0.1:3002";

function makeWallet(storage: SecureStorageProvider) {
  return new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: ESPLORA },
    storage,
    socketProvider: mockSocketProvider,
    wasmBinary: loadWasmBinary(),
  });
}

describe("getPeerAddresses", () => {
  it("returns the parsed peer address book from storage without starting the node", async () => {
    const book = {
      "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24": { host: "1.2.3.4", port: 9735 },
    };
    const { storage } = memStorage({ peer_addresses: JSON.stringify(book) });
    const wallet = makeWallet(storage);
    await expect(wallet.getPeerAddresses()).resolves.toEqual(book);
  });

  it("returns an empty book when nothing is stored", async () => {
    const { storage } = memStorage();
    const wallet = makeWallet(storage);
    await expect(wallet.getPeerAddresses()).resolves.toEqual({});
  });
});

describe("PaymentTimeoutError", () => {
  it("is exported, typed, and carries a boundary-stable code in the message", () => {
    const e = new PaymentTimeoutError("aa".repeat(32));
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("PAYMENT_TIMEOUT");
    expect(e.message).toContain("PAYMENT_TIMEOUT");
    expect(e.paymentHash).toBe("aa".repeat(32));
  });
});

describe("payBolt11", () => {
  beforeEach(() => {
    server.use(
      http.get(`${ESPLORA}/fee-estimates`, () => HttpResponse.json({})),
      http.get(`${ESPLORA}/blocks/tip/height`, () => HttpResponse.text("0")),
      http.get(`${ESPLORA}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
    );
  });

  it("rejects before start with a not-started error", async () => {
    const { storage } = memStorage();
    const wallet = makeWallet(storage);
    await expect(wallet.payBolt11("lnbc1notstarted")).rejects.toThrow(/not started/i);
  });

  it("rejects an invalid invoice string and persists no payment record", async () => {
    const { storage, writes } = memStorage();
    const wallet = makeWallet(storage);
    await wallet.start();
    try {
      await expect(wallet.payBolt11("garbage-not-an-invoice")).rejects.toThrow(/invalid bolt11/i);
      expect(writes.filter((k) => k.startsWith("tx_"))).toHaveLength(0);
    } finally {
      await wallet.stop();
    }
  });

  it("rejects a zero-amount invoice and persists no payment record", async () => {
    const { storage, writes } = memStorage();
    const wallet = makeWallet(storage);
    await wallet.start();
    try {
      await expect(wallet.payBolt11(ZERO_AMOUNT_INVOICE)).rejects.toThrow(/zero-amount/i);
      expect(writes.filter((k) => k.startsWith("tx_"))).toHaveLength(0);
    } finally {
      await wallet.stop();
    }
  });

  it("fails cleanly on a channel-less node and finalizes the payment record as failed", async () => {
    const { storage } = memStorage();
    const wallet = makeWallet(storage);
    await wallet.start();
    try {
      // A real amount-carrying invoice minted by this same node; with no channels the
      // send fails to initiate (no route), which must NOT strand a pending record.
      const invoice = await wallet.createInvoice(1000, "pay-bolt11 test");
      const err = await wallet.payBolt11(invoice).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      // A failed initiation is a definitive failure, never reported as an in-flight timeout.
      expect(err).not.toBeInstanceOf(PaymentTimeoutError);

      const records = await wallet.getPayments();
      expect(records).toHaveLength(1);
      expect(records[0].direction).toBe("sent");
      expect(records[0].type).toBe("bolt11");
      expect(records[0].amountSats).toBe(1000);
      expect(records[0].status).toBe("failed");
    } finally {
      await wallet.stop();
    }
  });
});
