// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "../../index";
import { bytesToHex } from "../../storage-cache";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
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

const lspApiUrl = "http://127.0.0.1:9099/lsps1";
const esploraUrl = "http://127.0.0.1:3002";

const mswServer = setupServer(
  // Esplora endpoints mocked statically
  http.get(`${esploraUrl}/blocks/tip/height`, () => {
    return HttpResponse.text("100");
  }),
  http.get(`${esploraUrl}/blocks/tip/hash`, () => {
    return HttpResponse.text("0000000000000000000000000000000000000000000000000000000000000000");
  }),
  // Reorg check in sync() asks for the hash at the manager's best height; returning
  // the same tip hash makes it short-circuit (no reorg) so a fresh, channel-less
  // wallet syncs to a no-op without a live esplora backend.
  http.get(`${esploraUrl}/block-height/:height`, () => {
    return HttpResponse.text("0000000000000000000000000000000000000000000000000000000000000000");
  }),
  http.get(`${esploraUrl}/fee-estimates`, () => {
    return HttpResponse.json({ "1": 15.0, "6": 8.0, "144": 2.0 });
  }),

  // LSPS1 API Mocks
  http.post(lspApiUrl, async ({ request }) => {
    const body = (await request.clone().json()) as any;
    const { id, method } = body;

    if (method === "lsps1.get_info") {
      return HttpResponse.json({
        jsonrpc: "2.0",
        id,
        result: {
          min_channel_balance_sat: "20000",
          max_channel_balance_sat: "1000000",
          min_initial_client_balance_sat: "0",
          max_initial_client_balance_sat: "0",
          min_channel_expiry_blocks: 2016,
          max_channel_expiry_blocks: 4032,
        },
      });
    }

    if (method === "lsps1.create_order") {
      return HttpResponse.json({
        jsonrpc: "2.0",
        id,
        result: {
          order_id: "test_order_id_123",
          lsp_balance_sat: body.params.lsp_balance_sat,
          client_balance_sat: "0",
          payment_value_msat: "500000",
          payment_addr: "00112233445566778899aabbccddeeff",
          invoice: "lnbc500n1pvjlxyz...",
        },
      });
    }

    return HttpResponse.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  })
);

class MockSocketProvider implements WebSocketStreamProvider {
  async connect(): Promise<WebSocketConnection> {
    return {
      send: () => {},
      close: () => {},
    };
  }
}

describe("LibreListenerWallet LSPS1 Inbound Capacity Purchase Tests", () => {
  beforeAll(() => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
  });

  afterEach(() => {
    mswServer.resetHandlers();
  });

  afterAll(() => {
    mswServer.close();
  });

  it("should query LSPS1 info and successfully purchase inbound capacity", async () => {
    const db = new Map<string, string>();
    const storage: SecureStorageProvider = {
      getItem: async (k) => db.get(k) || null,
      setItem: async (k, v) => {
        db.set(k, v);
      },
      removeItem: async (k) => {
        db.delete(k);
      },
    };

    const wallet = new LibreListenerWallet({
      config: {
        network: "regtest",
        esploraUrl,
      },
      storage,
      socketProvider: new MockSocketProvider(),
      wasmBinary: loadWasmBinary(),
      logger: {
        info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
        error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
      },
    });

    await wallet.start();

    const lsp = {
      name: "mock-lsp",
      pubkey: "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24",
      connection_string: "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24@127.0.0.1:9735",
      api_url: lspApiUrl,
      protocols: ["lsps1" as const],
    };

    // Purchase inbound capacity
    const invoice = await wallet.purchaseLSPS1Capacity({
      amountSats: 50000,
      lsp,
    });

    expect(invoice).toBe("lnbc500n1pvjlxyz...");

    await wallet.stop();
  });

  it("should throw error if requested capacity is outside LSP limits", async () => {
    const db = new Map<string, string>();
    const storage: SecureStorageProvider = {
      getItem: async (k) => db.get(k) || null,
      setItem: async (k, v) => {
        db.set(k, v);
      },
      removeItem: async (k) => {
        db.delete(k);
      },
    };

    const wallet = new LibreListenerWallet({
      config: {
        network: "regtest",
        esploraUrl,
      },
      storage,
      socketProvider: new MockSocketProvider(),
      wasmBinary: loadWasmBinary(),
    });

    await wallet.start();

    const lsp = {
      name: "mock-lsp",
      pubkey: "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24",
      connection_string: "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24@127.0.0.1:9735",
      api_url: lspApiUrl,
      protocols: ["lsps1" as const],
    };

    // LSP min limit is 20000, 5000 sat should fail
    await expect(
      wallet.purchaseLSPS1Capacity({
        amountSats: 5000,
        lsp,
      })
    ).rejects.toThrow("Requested amount 5000 sat is outside LSP bounds");

    await wallet.stop();
  });

  // Helper: boot a wallet with a fresh in-memory store.
  async function bootWallet() {
    const db = new Map<string, string>();
    const storage: SecureStorageProvider = {
      getItem: async (k) => db.get(k) || null,
      setItem: async (k, v) => {
        db.set(k, v);
      },
      removeItem: async (k) => {
        db.delete(k);
      },
    };
    const wallet = new LibreListenerWallet({
      config: { network: "regtest", esploraUrl },
      storage,
      socketProvider: new MockSocketProvider(),
      wasmBinary: loadWasmBinary(),
    });
    await wallet.start();
    return wallet;
  }

  const lsp = {
    name: "mock-lsp",
    pubkey: "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24",
    connection_string: "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24@127.0.0.1:9735",
    api_url: lspApiUrl,
    protocols: ["lsps1" as const],
  };

  // Install a create_order handler that records the request params so tests can
  // assert what lease duration was actually sent to the LSP. LSP advertises
  // min_channel_expiry_blocks=2016, max_channel_expiry_blocks=4032.
  function captureCreateOrder(): { last: () => any } {
    let captured: any = null;
    mswServer.use(
      http.post(lspApiUrl, async ({ request }) => {
        const body = (await request.clone().json()) as any;
        const { id, method } = body;
        if (method === "lsps1.get_info") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id,
            result: {
              min_channel_balance_sat: "20000",
              max_channel_balance_sat: "1000000",
              min_initial_client_balance_sat: "0",
              max_initial_client_balance_sat: "0",
              min_channel_expiry_blocks: 2016,
              max_channel_expiry_blocks: 4032,
            },
          });
        }
        if (method === "lsps1.create_order") {
          captured = body.params;
          return HttpResponse.json({
            jsonrpc: "2.0",
            id,
            result: {
              order_id: "order_capture",
              lsp_balance_sat: body.params.lsp_balance_sat,
              client_balance_sat: "0",
              invoice: "lnbc_capture...",
            },
          });
        }
        return HttpResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      })
    );
    return { last: () => captured };
  }

  it("defaults the lease to the LSP's max channel_expiry_blocks (longest lifetime)", async () => {
    const wallet = await bootWallet();
    const rec = captureCreateOrder();

    await wallet.purchaseLSPS1Capacity({ amountSats: 50000, lsp });

    expect(rec.last().channel_expiry_blocks).toBe(4032);
    expect(rec.last().announce_channel).toBe(false);

    await wallet.stop();
  });

  it("forwards a requested lease duration within the LSP's bounds", async () => {
    const wallet = await bootWallet();
    const rec = captureCreateOrder();

    await wallet.purchaseLSPS1Capacity({ amountSats: 50000, lsp, channelExpiryBlocks: 3000 });

    expect(rec.last().channel_expiry_blocks).toBe(3000);

    await wallet.stop();
  });

  it("clamps a requested lease above the LSP max down to the max", async () => {
    const wallet = await bootWallet();
    const rec = captureCreateOrder();

    await wallet.purchaseLSPS1Capacity({ amountSats: 50000, lsp, channelExpiryBlocks: 52560 });

    expect(rec.last().channel_expiry_blocks).toBe(4032);

    await wallet.stop();
  });

  it("clamps a requested lease below the LSP min up to the min", async () => {
    const wallet = await bootWallet();
    const rec = captureCreateOrder();

    await wallet.purchaseLSPS1Capacity({ amountSats: 50000, lsp, channelExpiryBlocks: 100 });

    expect(rec.last().channel_expiry_blocks).toBe(2016);

    await wallet.stop();
  });

  it("can request an announced (public) channel when asked", async () => {
    const wallet = await bootWallet();
    const rec = captureCreateOrder();

    await wallet.purchaseLSPS1Capacity({ amountSats: 50000, lsp, announceChannel: true });

    expect(rec.last().announce_channel).toBe(true);

    await wallet.stop();
  });

  it("reads the invoice from the spec-compliant payment.bolt11.invoice shape", async () => {
    const wallet = await bootWallet();
    mswServer.use(
      http.post(lspApiUrl, async ({ request }) => {
        const body = (await request.clone().json()) as any;
        const { id, method } = body;
        if (method === "lsps1.get_info") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id,
            result: {
              min_channel_balance_sat: "20000",
              max_channel_balance_sat: "1000000",
              min_initial_client_balance_sat: "0",
              max_initial_client_balance_sat: "0",
              min_channel_expiry_blocks: 2016,
              max_channel_expiry_blocks: 4032,
            },
          });
        }
        if (method === "lsps1.create_order") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id,
            result: {
              order_id: "order_spec",
              lsp_balance_sat: body.params.lsp_balance_sat,
              client_balance_sat: "0",
              payment: { bolt11: { invoice: "lnbc_spec_shape..." } },
            },
          });
        }
        return HttpResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      })
    );

    const invoice = await wallet.purchaseLSPS1Capacity({ amountSats: 50000, lsp });
    expect(invoice).toBe("lnbc_spec_shape...");

    await wallet.stop();
  });
});
