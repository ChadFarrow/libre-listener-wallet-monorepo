// End-to-end proof of the "get a channel from an LSP" flow the PWA/extension drive, run entirely
// offline against @libre/lsps1-mock-server (a faithful mock of a mainnet LSPS1-REST provider) via
// MSW — no docker, no real LSP, no money. This exercises the SAME wallet methods the PWA controller
// calls (purchaseLSPS1Capacity → getLSPS1Order), so you can build/regress that UI deterministically.
//
// Requires @libre/lsps1-mock-server to be built (its dist is imported). `pnpm test` builds it first;
// for a direct vitest run do `pnpm --filter @libre/lsps1-mock-server build` once.
import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
import { lsps1OrderStatus, zeroConfTrustedPubkeys } from "@libre/shared";
import { MockLsps1Provider } from "@libre/lsps1-mock-server";
import { mockLsps1MswHandlers } from "@libre/lsps1-mock-server/msw";
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
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}

const ESPLORA = "http://127.0.0.1:3002";
const MOCK_BASE = "http://mock-lsp.test/lsps1/v1";
// Megalith's real 0-conf pubkey — allowlisted by zeroConfTrustedPubkeys(); the mock advertises it
// so the 0-conf request path lines up (as it would against the real Megalith).
const MEGALITH_PUBKEY = "038a9e56512ec98da2b5789761f7af8f280baf98a09282360cd6ff1381b5e889bf";

const mockStorage = (): SecureStorageProvider => {
  const db = new Map<string, string>();
  return {
    getItem: async (k) => db.get(k) ?? null,
    setItem: async (k, v) => void db.set(k, v),
    removeItem: async (k) => void db.delete(k),
  };
};
const mockSocketProvider: WebSocketStreamProvider = {
  connect: async () => ({ send: () => {}, close: () => {} } as unknown as WebSocketConnection),
};

async function bootWallet(config: Partial<{ trustedZeroConfPeers: string[] }> = {}) {
  const wallet = new LibreListenerWallet({
    config: { network: "regtest", esploraUrl: ESPLORA, ...config },
    storage: mockStorage(),
    socketProvider: mockSocketProvider,
    wasmBinary: loadWasmBinary(),
  });
  await wallet.start();
  return wallet;
}

const lsp = {
  name: "Mock LSP",
  pubkey: MEGALITH_PUBKEY,
  connection_string: `${MEGALITH_PUBKEY}@127.0.0.1:9999`,
  api_url: MOCK_BASE,
  protocols: ["lsps1" as const],
};

describe("LSPS1 buy-a-channel flow against the mock provider", () => {
  beforeEach(() => {
    server.use(
      http.get(`${ESPLORA}/fee-estimates`, () => HttpResponse.json({})),
      http.get(`${ESPLORA}/blocks/tip/height`, () => HttpResponse.text("0")),
      http.get(`${ESPLORA}/blocks/tip/hash`, () => HttpResponse.text("00".repeat(32))),
    );
  });

  it("purchaseLSPS1Capacity returns an order+invoice+fee and sends a well-formed create_order", async () => {
    const provider = new MockLsps1Provider({ nodePubkey: MEGALITH_PUBKEY });
    server.use(...mockLsps1MswHandlers(MOCK_BASE, provider));
    const wallet = await bootWallet();

    const res = await wallet.purchaseLSPS1Capacity({ amountSats: 1_000_000, lsp });

    expect(res.orderId).toMatch(/^mock-order-/);
    expect(res.invoice).toMatch(/^lnbcmock/);
    expect(res.feeTotalSat).toBe("6000"); // 2000 base + 4000 ppm on 1M
    expect(res.lspPeerUri).toBe(`${MEGALITH_PUBKEY}@127.0.0.1:9999`);

    // What the app actually put on the wire (bLIP-51 shape).
    const sent = provider.lastCreateOrder!;
    expect(sent.lsp_balance_sat).toBe("1000000");
    expect(sent.channel_expiry_blocks).toBe(13140); // defaults to the LSP max
    expect(sent.announce_channel).toBe(false);
    expect(sent.public_key).toMatch(/^[0-9a-f]{66}$/); // the wallet's node id

    await wallet.stop();
  });

  it("rejects an amount below the LSP minimum before placing an order", async () => {
    const provider = new MockLsps1Provider({ minChannelSat: 150_000, nodePubkey: MEGALITH_PUBKEY });
    server.use(...mockLsps1MswHandlers(MOCK_BASE, provider));
    const wallet = await bootWallet();

    await expect(wallet.purchaseLSPS1Capacity({ amountSats: 1_000, lsp })).rejects.toThrow(/outside/);
    expect(provider.lastCreateOrder).toBeUndefined(); // never reached create_order

    await wallet.stop();
  });

  it("getLSPS1Order tracks the order awaiting_payment → paid → completed", async () => {
    const provider = new MockLsps1Provider({ advance: "manual", nodePubkey: MEGALITH_PUBKEY });
    server.use(...mockLsps1MswHandlers(MOCK_BASE, provider));
    const wallet = await bootWallet();

    const { orderId } = await wallet.purchaseLSPS1Capacity({ amountSats: 1_000_000, lsp });

    const awaiting = await wallet.getLSPS1Order(MOCK_BASE, orderId);
    expect(lsps1OrderStatus(awaiting)).toBe("awaiting_payment");

    provider.markPaid(orderId); // simulate the client paying the invoice
    const paid = await wallet.getLSPS1Order(MOCK_BASE, orderId);
    expect(lsps1OrderStatus(paid)).toBe("paid");

    provider.complete(orderId); // simulate the LSP opening the channel
    const completed = await wallet.getLSPS1Order(MOCK_BASE, orderId);
    expect(lsps1OrderStatus(completed)).toBe("completed");
    expect(completed.channel).toBeTruthy();

    await wallet.stop();
  });

  it("requests 0-conf only for a trusted 0-conf LSP; a 3-conf LSP gets its confirmed depth", async () => {
    // Trusted 0-conf provider (Megalith pubkey allowlisted) → required_channel_confirmations: 0.
    const zeroConf = new MockLsps1Provider({ minRequiredChannelConfirmations: 0, nodePubkey: MEGALITH_PUBKEY });
    server.use(...mockLsps1MswHandlers(MOCK_BASE, zeroConf));
    const trustedWallet = await bootWallet({ trustedZeroConfPeers: zeroConfTrustedPubkeys() });
    await trustedWallet.purchaseLSPS1Capacity({ amountSats: 1_000_000, lsp });
    expect(zeroConf.lastCreateOrder!.required_channel_confirmations).toBe(0);
    await trustedWallet.stop();

    // A 3-conf LSP → the wallet requests its confirmed depth, never 0-conf.
    const confirmed = new MockLsps1Provider({ minRequiredChannelConfirmations: 3, nodePubkey: MEGALITH_PUBKEY });
    server.use(...mockLsps1MswHandlers(MOCK_BASE, confirmed));
    const wallet = await bootWallet({ trustedZeroConfPeers: zeroConfTrustedPubkeys() });
    await wallet.purchaseLSPS1Capacity({ amountSats: 1_000_000, lsp });
    expect(confirmed.lastCreateOrder!.required_channel_confirmations).toBe(3);
    await wallet.stop();
  });
});
