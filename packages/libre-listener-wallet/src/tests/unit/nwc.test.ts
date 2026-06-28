import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { NwcManager } from "../../nwc-manager";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider, WebSocketConnection } from "../../index";
import { Relay, generateSecretKey, getPublicKey, nip04 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "../../storage-cache";
import { nwcRequestSchema } from "@libre/shared";
import {
  Event_PaymentSent,
  Event_PaymentFailed,
  Option_ThirtyTwoBytesZ_Some,
  Bolt11Invoice,
  Option_u64Z_Some,
  UtilMethods,
  Retry,
  initializeWasmFromBinary
} from "lightningdevkit";
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

beforeAll(async () => {
  try {
    await initializeWasmFromBinary(loadWasmBinary());
  } catch (e) {
    // ignore if already initialized
  }
});

// Spy on Relay.connect
const mockPublish = vi.fn();
const mockSubscribeClose = vi.fn();
let subHandler: ((event: any) => Promise<void>) | null = null;

const mockRelay = {
  subscribe: vi.fn().mockImplementation((filters, handlers) => {
    subHandler = handlers.onevent;
    return {
      close: mockSubscribeClose,
    };
  }),
  publish: mockPublish.mockResolvedValue(undefined),
  close: vi.fn(),
};

vi.spyOn(Relay, "connect").mockResolvedValue(mockRelay as any);

describe("Nostr Wallet Connect (NWC) Unit Tests", () => {
  let wallet: LibreListenerWallet;
  let nwc: NwcManager;
  let mockStorage: Record<string, string>;
  let storageProvider: SecureStorageProvider;

  const mockSocketProvider: WebSocketStreamProvider = {
    connect: async () =>
      ({
        send: () => {},
        close: () => {},
      } as unknown as WebSocketConnection),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    subHandler = null;
    mockStorage = {};
    storageProvider = {
      getItem: async (key) => mockStorage[key] || null,
      setItem: async (key, val) => {
        mockStorage[key] = val;
      },
      removeItem: async (key) => {
        delete mockStorage[key];
      },
    };

    wallet = new LibreListenerWallet({
      config: {
        network: "regtest",
        esploraUrl: "http://127.0.0.1:3002",
      },
      storage: storageProvider,
      socketProvider: mockSocketProvider,
    });

    nwc = wallet.nwc;
    await nwc.init();
  });

  describe("URI Generation and Connection Management", () => {
    it("should generate a valid connection URI and save it to storage", async () => {
      const uri = await nwc.createConnection("Test App", {
        spendingLimitSats: 5000,
        relayUrl: "wss://relay.test.io",
      });

      expect(uri).toContain("nostr+walletconnect://");
      expect(uri).toContain("relay=wss%3A%2F%2Frelay.test.io");
      expect(uri).toContain("secret=");

      const connections = await nwc.listConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0].name).toBe("Test App");
      expect(connections[0].spendingLimitSats).toBe(5000);
      expect(connections[0].relayUrl).toBe("wss://relay.test.io");
      expect(connections[0].enabled).toBe(true);

      const stored = await storageProvider.getItem("nwc_connections");
      expect(stored).toBeDefined();
      expect(JSON.parse(stored!)).toHaveLength(1);
    });

    it("should allow updating and deleting connections", async () => {
      await nwc.createConnection("App 1", { spendingLimitSats: 1000 });
      const connections = await nwc.listConnections();
      const pubkey = connections[0].clientPubkey;

      await nwc.updateConnection(pubkey, { enabled: false, spendingLimitSats: 2000 });
      let updated = await nwc.listConnections();
      expect(updated[0].enabled).toBe(false);
      expect(updated[0].spendingLimitSats).toBe(2000);

      await nwc.deleteConnection(pubkey);
      const remaining = await nwc.listConnections();
      expect(remaining).toHaveLength(0);
    });
  });

  describe("JSON-RPC Request validation schemas", () => {
    it("should validate valid NWC schemas via zod", () => {
      const validGetInfo = { method: "get_info" };
      const parsedInfo = nwcRequestSchema.safeParse(validGetInfo);
      expect(parsedInfo.success).toBe(true);

      const validPayInvoice = {
        method: "pay_invoice",
        params: { invoice: "lnbc10n1..." },
      };
      const parsedPay = nwcRequestSchema.safeParse(validPayInvoice);
      expect(parsedPay.success).toBe(true);

      const invalidPay = {
        method: "pay_invoice",
        params: {},
      };
      const parsedInvalid = nwcRequestSchema.safeParse(invalidPay);
      expect(parsedInvalid.success).toBe(false);
    });
  });

  describe("Daily Spending Limit Calculations", () => {
    it("should allow payments within limit and block when daily limit is exceeded", async () => {
      const clientSecretBytes = generateSecretKey();
      const clientSecretHex = bytesToHex(clientSecretBytes);
      const clientPubkeyHex = getPublicKey(clientSecretBytes);

      // Add a mock connection manually so we have access to the secret key
      const connection = {
        name: "Limited App",
        clientPubkey: clientPubkeyHex,
        secret: clientSecretHex,
        spendingLimitSats: 100,
        spentTodaySats: 0,
        lastSpentTimestamp: Date.now(),
        createdAt: Date.now(),
        enabled: true,
        relayUrl: "wss://relay.test.io",
      };
      nwc["connections"].push(connection);
      await nwc["saveConnections"]();

      // Mock ChannelManager
      const mockChannelManager = {
        current_best_block: () => ({
          get_height: () => 100,
          get_block_hash: () => new Uint8Array(32),
        }),
        get_our_node_id: () => new Uint8Array(33),
        list_channels: () => [],
        send_payment: () => ({
          is_ok: () => true,
        }),
      };
      vi.spyOn(wallet, "getChannelManager").mockReturnValue(mockChannelManager as any);

      // Start nwc to connect to relays
      await nwc.start();
      await new Promise((r) => setTimeout(r, 50));
      expect(Relay.connect).toHaveBeenCalledWith("wss://relay.test.io");
      expect(subHandler).not.toBeNull();

      // Mock an LDK Event_PaymentSent resolution helper
      const resolvePayment = (paymentHash: string, preimage: string) => {
        const ev = Object.create(Event_PaymentSent.prototype);
        ev.payment_hash = hexToBytes(paymentHash);
        ev.payment_preimage = hexToBytes(preimage);
        // Find LDK event listener in wallet and call it
        wallet["eventListeners"].forEach((listener) => listener(ev));
      };

      // Mock pay_invoice params (worth 60 sats)
      const mockInvoice = {
        amount_milli_satoshis: () => Option_u64Z_Some.constructor_some(60000n),
      };
      vi.spyOn(Bolt11Invoice, "constructor_from_str").mockReturnValue({
        is_ok: () => true,
        res: mockInvoice,
      } as any);

      const mockRouteParamsTuple = {
        get_a: () => new Uint8Array(32), // payment_hash
        get_b: () => ({}), // onionFields
        get_c: () => ({}), // routeParams
      };
      vi.spyOn(UtilMethods, "constructor_payment_parameters_from_invoice").mockReturnValue({
        is_ok: () => true,
        res: mockRouteParamsTuple,
      } as any);

      vi.spyOn(Retry, "constructor_attempts").mockReturnValue({});

      // 1. Send first payment of 60 sats (should pass)
      const reqId1 = "req-1";
      const payload1 = JSON.stringify({
        jsonrpc: "2.0",
        id: reqId1,
        method: "pay_invoice",
        params: { invoice: "lnbc60n..." },
      });
      const walletPubkeyHex = nwc["walletPubkey"]!;
      const encryptedPayload1 = await nip04.encrypt(clientSecretHex, walletPubkeyHex, payload1);

      const event1 = {
        kind: 23194,
        pubkey: clientPubkeyHex,
        content: encryptedPayload1,
        id: "evt-1",
      };

      // Handle the request asynchronously
      const handlePromise1 = subHandler!(event1);
      
      // Simulate LDK Event_PaymentSent resolution
      await new Promise((r) => setTimeout(r, 50));
      resolvePayment(bytesToHex(new Uint8Array(32)), bytesToHex(new Uint8Array([1, 2, 3])));
      await handlePromise1;

      // Assert result is published
      expect(mockPublish).toHaveBeenCalled();
      const lastCallEvent = mockPublish.mock.calls.find(c => c[0].kind === 23195)?.[0];
      expect(lastCallEvent).toBeDefined();
      expect(lastCallEvent!.kind).toBe(23195);
      const responsePlain = await nip04.decrypt(clientSecretHex, walletPubkeyHex, lastCallEvent!.content);
      const responseObj = JSON.parse(responsePlain);
      expect(responseObj.id).toBe(reqId1);
      expect(responseObj.result.preimage).toBeDefined();

      // Check cumulative spending
      let conn = (await nwc.listConnections())[0];
      expect(conn.spentTodaySats).toBe(60);

      // 2. Send second payment of 50 sats (total 110/100 -> should fail with QUOTA_EXCEEDED)
      mockPublish.mockClear();
      
      // Update mockInvoice for 50 sats
      mockInvoice.amount_milli_satoshis = () => Option_u64Z_Some.constructor_some(50000n);

      const reqId2 = "req-2";
      const payload2 = JSON.stringify({
        jsonrpc: "2.0",
        id: reqId2,
        method: "pay_invoice",
        params: { invoice: "lnbc50n..." },
      });
      const encryptedPayload2 = await nip04.encrypt(clientSecretHex, walletPubkeyHex, payload2);
      const event2 = {
        kind: 23194,
        pubkey: clientPubkeyHex,
        content: encryptedPayload2,
        id: "evt-2",
      };

      await subHandler!(event2);

      expect(mockPublish).toHaveBeenCalled();
      const quotaExceededCall = mockPublish.mock.calls[0][0];
      const quotaResponsePlain = await nip04.decrypt(clientSecretHex, walletPubkeyHex, quotaExceededCall.content);
      const quotaResponseObj = JSON.parse(quotaResponsePlain);
      expect(quotaResponseObj.id).toBe(reqId2);
      expect(quotaResponseObj.error.code).toBe("QUOTA_EXCEEDED");

      // Verify spent cumulative is still 60
      conn = (await nwc.listConnections())[0];
      expect(conn.spentTodaySats).toBe(60);

      // 3. Mock 24h passage and check limit resets
      const originalNow = Date.now;
      Date.now = () => originalNow() + 25 * 60 * 60 * 1000; // +25 hours

      mockPublish.mockClear();
      const reqId3 = "req-3";
      const payload3 = JSON.stringify({
        jsonrpc: "2.0",
        id: reqId3,
        method: "pay_invoice",
        params: { invoice: "lnbc50n..." },
      });
      const encryptedPayload3 = await nip04.encrypt(clientSecretHex, walletPubkeyHex, payload3);
      const event3 = {
        kind: 23194,
        pubkey: clientPubkeyHex,
        content: encryptedPayload3,
        id: "evt-3",
      };

      const handlePromise3 = subHandler!(event3);
      await new Promise((r) => setTimeout(r, 50));
      resolvePayment(bytesToHex(new Uint8Array(32)), bytesToHex(new Uint8Array([4, 5, 6])));
      await handlePromise3;

      expect(mockPublish).toHaveBeenCalled();
      // Find the kind-23195 response (a payment_sent notification may also publish on settle).
      const successCall3 = mockPublish.mock.calls.map((c) => c[0]).find((e: any) => e.kind === 23195);
      expect(successCall3).toBeDefined();
      const res3Plain = await nip04.decrypt(clientSecretHex, walletPubkeyHex, successCall3.content);
      const res3Obj = JSON.parse(res3Plain);
      expect(res3Obj.id).toBe(reqId3);
      expect(res3Obj.result.preimage).toBeDefined();

      // Limit should have reset and now have spent 50 sats
      conn = (await nwc.listConnections())[0];
      expect(conn.spentTodaySats).toBe(50);

      // Restore Date.now
      Date.now = originalNow;
    });

    it("does not let concurrent requests exceed the daily limit (no TOCTOU race)", async () => {
      const clientSecretBytes = generateSecretKey();
      const clientSecretHex = bytesToHex(clientSecretBytes);
      const clientPubkeyHex = getPublicKey(clientSecretBytes);

      nwc["connections"].push({
        name: "Race App",
        clientPubkey: clientPubkeyHex,
        secret: clientSecretHex,
        spendingLimitSats: 100,
        spentTodaySats: 0,
        lastSpentTimestamp: Date.now(),
        createdAt: Date.now(),
        enabled: true,
        relayUrl: "wss://relay.test.io",
      });
      await nwc["saveConnections"]();

      vi.spyOn(wallet, "getChannelManager").mockReturnValue({
        current_best_block: () => ({ get_height: () => 100, get_block_hash: () => new Uint8Array(32) }),
        get_our_node_id: () => new Uint8Array(33),
        list_channels: () => [],
        send_payment: () => ({ is_ok: () => true }),
      } as any);

      // Each pay_invoice is worth 60 sats; two of them (120) exceed the 100 cap.
      vi.spyOn(Bolt11Invoice, "constructor_from_str").mockReturnValue({
        is_ok: () => true,
        res: { amount_milli_satoshis: () => Option_u64Z_Some.constructor_some(60000n) },
      } as any);

      // Distinct payment hash per request so each can resolve independently.
      const usedHashes: string[] = [];
      let hashCounter = 0;
      vi.spyOn(UtilMethods, "constructor_payment_parameters_from_invoice").mockImplementation(() => {
        const h = new Uint8Array(32);
        h[0] = ++hashCounter;
        usedHashes.push(bytesToHex(h));
        return { is_ok: () => true, res: { get_a: () => h, get_b: () => ({}), get_c: () => ({}) } } as any;
      });
      vi.spyOn(Retry, "constructor_attempts").mockReturnValue({} as any);

      await nwc.start();
      await new Promise((r) => setTimeout(r, 50));
      const walletPubkeyHex = nwc["walletPubkey"]!;

      const mkEvent = async (id: string) => ({
        kind: 23194,
        pubkey: clientPubkeyHex,
        id: `evt-${id}`,
        content: await nip04.encrypt(
          clientSecretHex,
          walletPubkeyHex,
          JSON.stringify({ jsonrpc: "2.0", id, method: "pay_invoice", params: { invoice: "lnbc60n..." } })
        ),
      });
      const resolvePayment = (hashHex: string) => {
        const ev = Object.create(Event_PaymentSent.prototype);
        ev.payment_hash = hexToBytes(hashHex);
        ev.payment_preimage = new Uint8Array([7]);
        wallet["eventListeners"].forEach((l) => l(ev));
      };

      const e1 = await mkEvent("r1");
      const e2 = await mkEvent("r2");
      mockPublish.mockClear();
      // Fire both concurrently.
      const p1 = subHandler!(e1);
      const p2 = subHandler!(e2);

      // Resolve whatever actually got sent (serialized: only the first; racing: both).
      await new Promise((r) => setTimeout(r, 80));
      if (usedHashes[0]) resolvePayment(usedHashes[0]);
      await new Promise((r) => setTimeout(r, 80));
      if (usedHashes[1]) resolvePayment(usedHashes[1]);
      await new Promise((r) => setTimeout(r, 80));
      await Promise.all([p1, p2]);

      const responses = await Promise.all(
        mockPublish.mock.calls
          .filter((c) => c[0].kind === 23195)
          .map(async (c) => JSON.parse(await nip04.decrypt(clientSecretHex, walletPubkeyHex, c[0].content)))
      );
      const successes = responses.filter((r) => r.result?.preimage).length;
      const quota = responses.filter((r) => r.error?.code === "QUOTA_EXCEEDED").length;
      expect(successes).toBe(1);
      expect(quota).toBe(1);
      expect((await nwc.listConnections())[0].spentTodaySats).toBeLessThanOrEqual(100);
    });
  });

  describe("make_invoice response — no preimage leak (guardrail)", () => {
    it("does not include the unpaid-invoice preimage in the make_invoice response", async () => {
      const clientSecretBytes = generateSecretKey();
      const clientSecretHex = bytesToHex(clientSecretBytes);
      const clientPubkeyHex = getPublicKey(clientSecretBytes);

      nwc["connections"].push({
        name: "Invoice App",
        clientPubkey: clientPubkeyHex,
        secret: clientSecretHex,
        spendingLimitSats: 0,
        spentTodaySats: 0,
        lastSpentTimestamp: Date.now(),
        createdAt: Date.now(),
        enabled: true,
        relayUrl: "wss://relay.test.io",
      });
      await nwc["saveConnections"]();

      // buildInvoice reads the private channelManager field; createInvoice persists the preimage.
      (wallet as any).channelManager = {};
      vi.spyOn(UtilMethods, "constructor_create_invoice_from_channelmanager_with_payment_hash").mockReturnValue({
        is_ok: () => true,
        res: { to_str: () => "lnbc10u1pfakeinvoice" },
      } as any);
      // make_invoice re-parses the created invoice to report its payment_hash.
      vi.spyOn(Bolt11Invoice, "constructor_from_str").mockReturnValue({
        is_ok: () => true,
        res: { payment_hash: () => new Uint8Array(32) },
      } as any);

      await nwc.start();
      await new Promise((r) => setTimeout(r, 50));

      const walletPubkeyHex = nwc["walletPubkey"]!;
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: "mk-1",
        method: "make_invoice",
        params: { amount: 1000000, description: "test" },
      });
      const encrypted = await nip04.encrypt(clientSecretHex, walletPubkeyHex, payload);
      mockPublish.mockClear();
      await subHandler!({ kind: 23194, pubkey: clientPubkeyHex, content: encrypted, id: "evt-mk-1" });

      const respCall = mockPublish.mock.calls.find((c) => c[0].kind === 23195)?.[0];
      expect(respCall).toBeDefined();
      const plain = await nip04.decrypt(clientSecretHex, walletPubkeyHex, respCall!.content);
      const obj = JSON.parse(plain);
      // The invoice + payment_hash are returned, but the preimage (a claim secret for
      // an as-yet-unpaid invoice) must NOT be sent over the relay.
      expect(obj.result.invoice).toBe("lnbc10u1pfakeinvoice");
      expect(obj.result.payment_hash).toBeDefined();
      expect(obj.result.preimage).toBeUndefined();
    });
  });

  describe("NIP-47 Notifications (payment_sent)", () => {
    const RELAY = "wss://relay.test.io";

    // Push a connection with a known secret, mock the channel manager, and start so a
    // relay (mockRelay) is connected. Returns the client/wallet keys for de/encryption.
    async function setupConnAndStart() {
      const clientSecretBytes = generateSecretKey();
      const clientSecretHex = bytesToHex(clientSecretBytes);
      const clientPubkeyHex = getPublicKey(clientSecretBytes);
      nwc["connections"].push({
        name: "Notif App",
        clientPubkey: clientPubkeyHex,
        secret: clientSecretHex,
        spendingLimitSats: 0,
        spentTodaySats: 0,
        lastSpentTimestamp: Date.now(),
        createdAt: Date.now(),
        enabled: true,
        relayUrl: RELAY,
      });
      await nwc["saveConnections"]();
      const mockChannelManager = {
        current_best_block: () => ({ get_height: () => 100, get_block_hash: () => new Uint8Array(32) }),
        get_our_node_id: () => new Uint8Array(33),
        list_channels: () => [],
      };
      vi.spyOn(wallet, "getChannelManager").mockReturnValue(mockChannelManager as any);
      await nwc.start();
      await new Promise((r) => setTimeout(r, 50));
      return { clientSecretHex, clientPubkeyHex, walletPubkeyHex: nwc["walletPubkey"]! };
    }

    const fireSent = (hashHex: string, preimageHex: string) => {
      const ev = Object.create(Event_PaymentSent.prototype);
      ev.payment_hash = hexToBytes(hashHex);
      ev.payment_preimage = hexToBytes(preimageHex);
      wallet["eventListeners"].forEach((l: any) => l(ev));
    };

    const fireFailed = (hashHex: string) => {
      const ev = Object.create(Event_PaymentFailed.prototype);
      ev.payment_hash = Option_ThirtyTwoBytesZ_Some.constructor_some(hexToBytes(hashHex));
      wallet["eventListeners"].forEach((l: any) => l(ev));
    };

    const findKind = (kind: number) =>
      mockPublish.mock.calls.map((c) => c[0]).find((e: any) => e.kind === kind);

    it("publishes a kind-23196 payment_sent notification to the initiating client on settle", async () => {
      const { clientSecretHex, clientPubkeyHex, walletPubkeyHex } = await setupConnAndStart();
      const hashHex = bytesToHex(new Uint8Array(32).fill(9));
      const preimageHex = bytesToHex(new Uint8Array(32).fill(7));

      // Simulate the request handler having registered the initiating client for this hash.
      nwc["paymentContexts"].set(hashHex, { clientPubkey: clientPubkeyHex, relayUrl: RELAY, amountMsat: 5000 });

      fireSent(hashHex, preimageHex);
      await new Promise((r) => setTimeout(r, 50));

      const notif = findKind(23196);
      expect(notif).toBeDefined();
      expect(notif.tags).toContainEqual(["p", clientPubkeyHex]);
      const plain = await nip04.decrypt(clientSecretHex, walletPubkeyHex, notif.content);
      const obj = JSON.parse(plain);
      expect(obj.notification_type).toBe("payment_sent");
      expect(obj.notification.payment_hash).toBe(hashHex);
      expect(obj.notification.preimage).toBe(preimageHex);
      expect(obj.notification.amount).toBe(5000);
      // Settlement context is one-shot — cleared after notifying.
      expect(nwc["paymentContexts"].has(hashHex)).toBe(false);
    });

    it("advertises the notifications capability in the kind-13194 info event", async () => {
      await setupConnAndStart();
      const info = findKind(13194);
      expect(info).toBeDefined();
      expect(info.content).toContain("notifications");
      expect(info.tags).toContainEqual(["notifications", "payment_sent"]);
    });

    it("advertises notifications in the get_info result", async () => {
      const { clientSecretHex, clientPubkeyHex, walletPubkeyHex } = await setupConnAndStart();
      const payload = JSON.stringify({ jsonrpc: "2.0", id: "gi-1", method: "get_info", params: {} });
      const enc = await nip04.encrypt(clientSecretHex, walletPubkeyHex, payload);
      await subHandler!({ kind: 23194, pubkey: clientPubkeyHex, content: enc, id: "gi-evt" });

      const resp = findKind(23195);
      expect(resp).toBeDefined();
      const obj = JSON.parse(await nip04.decrypt(clientSecretHex, walletPubkeyHex, resp.content));
      expect(obj.result.notifications).toContain("payment_sent");
    });

    it("publishes no notification and clears context on payment failure", async () => {
      const { clientPubkeyHex } = await setupConnAndStart();
      const hashHex = bytesToHex(new Uint8Array(32).fill(3));
      nwc["paymentContexts"].set(hashHex, { clientPubkey: clientPubkeyHex, relayUrl: RELAY, amountMsat: 5000 });

      fireFailed(hashHex);
      await new Promise((r) => setTimeout(r, 50));

      expect(findKind(23196)).toBeUndefined();
      expect(nwc["paymentContexts"].has(hashHex)).toBe(false);
    });
  });
});

describe("NWC request schema — pay_keysend pubkey validation", () => {
  // A Lightning node pubkey is a 33-byte compressed key = 66 hex chars (02/03 prefix),
  // NOT a 32-byte (64-hex) Nostr key. Regression: the regex was {64} and rejected all keysends.
  const lnPubkey = "028ea4e01d6f7e6d80d2d6902eda9304c4bcda78a6abfda3dee2de94ef46a302d5";

  it("accepts a 66-char compressed Lightning pubkey", () => {
    const res = nwcRequestSchema.safeParse({
      method: "pay_keysend",
      params: { pubkey: lnPubkey, amount: 5000 },
    });
    expect(res.success).toBe(true);
  });

  it("rejects a 64-char (Nostr-style) pubkey for keysend", () => {
    const res = nwcRequestSchema.safeParse({
      method: "pay_keysend",
      params: { pubkey: lnPubkey.slice(2), amount: 5000 },
    });
    expect(res.success).toBe(false);
  });
});
