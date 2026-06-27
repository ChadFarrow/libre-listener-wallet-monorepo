import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip04,
  Relay
} from "nostr-tools";
import { z } from "zod";
import {
  nwcRequestSchema,
  NwcConnection,
  NWCRequestInput
} from "@libre/shared";
import {
  Bolt11Invoice,
  UtilMethods,
  Retry,
  Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK,
  Option_u64Z_Some,
  Option_ThirtyTwoBytesZ_Some,
  Event,
  Event_PaymentSent,
  Event_PaymentFailed
} from "lightningdevkit";
import { bytesToHex, hexToBytes } from "./storage-cache";
import { getSecureRandomBytes } from "./crypto-utils";
import type { LibreListenerWallet, Logger, SecureStorageProvider } from "./index";

export class NwcManager {
  private wallet: LibreListenerWallet;
  private logger?: Logger;
  private storage: SecureStorageProvider;
  private network: string;
  private connections: NwcConnection[] = [];
  private relays: Map<string, Relay> = new Map();
  private subs: Map<string, any> = new Map();
  private walletPrivKeyHex?: string;
  private walletPubkey?: string;
  private pendingPayments: Map<string, { resolve: (preimage: string) => void; reject: (err: Error) => void }> = new Map();
  private active: boolean = false;
  // Per-client request serialization so the spending-limit check-and-update is atomic.
  private requestChains: Map<string, Promise<void>> = new Map();
  private requestListeners: ((result: { eventId: string; method: string; success: boolean; error?: string }) => void)[] = [];

  constructor(wallet: LibreListenerWallet, deps: { logger?: Logger; storage: SecureStorageProvider; network: string }) {
    this.wallet = wallet;
    this.logger = deps.logger;
    this.storage = deps.storage;
    this.network = deps.network;
  }

  getWalletPubkey(): string | undefined {
    return this.walletPubkey;
  }

  onRequestProcessed(listener: (result: { eventId: string; method: string; success: boolean; error?: string }) => void) {
    this.requestListeners.push(listener);
  }

  offRequestProcessed(listener: (result: { eventId: string; method: string; success: boolean; error?: string }) => void) {
    this.requestListeners = this.requestListeners.filter(l => l !== listener);
  }

  private notifyRequestProcessed(eventId: string, method: string, success: boolean, error?: string) {
    for (const listener of this.requestListeners) {
      try {
        listener({ eventId, method, success, error });
      } catch (e) {
        this.logger?.error(`Error in NwcManager request listener: ${e}`);
      }
    }
  }

  async init(): Promise<void> {
    const storage = this.storage;
    
    // Load or generate NWC Wallet key pair
    let nwcPrivHex = await storage.getItem("nwc_wallet_private_key");
    if (!nwcPrivHex) {
      const secretBytes = generateSecretKey();
      nwcPrivHex = bytesToHex(secretBytes);
      await storage.setItem("nwc_wallet_private_key", nwcPrivHex);
    }
    this.walletPrivKeyHex = nwcPrivHex;
    this.walletPubkey = getPublicKey(hexToBytes(nwcPrivHex));

    // Load active pairings
    const connJson = await storage.getItem("nwc_connections");
    this.connections = connJson ? JSON.parse(connJson) as NwcConnection[] : [];

    // Register LDK event listener to capture payment status resolutions
    this.wallet.addEventListener((event: Event) => {
      const name = event.constructor.name;
      if (event instanceof Event_PaymentSent) {
        const hashHex = bytesToHex(event.payment_hash);
        const preimageHex = bytesToHex(event.payment_preimage);
        const resolver = this.pendingPayments.get(hashHex);
        if (resolver) {
          resolver.resolve(preimageHex);
          this.pendingPayments.delete(hashHex);
        }
      } else if (event instanceof Event_PaymentFailed) {
        let hashHex: string | undefined;
        if (event.payment_hash instanceof Option_ThirtyTwoBytesZ_Some) {
          hashHex = bytesToHex(event.payment_hash.some);
        }
        if (hashHex) {
          const resolver = this.pendingPayments.get(hashHex);
          if (resolver) {
            resolver.reject(new Error("LDK payment execution failed"));
            this.pendingPayments.delete(hashHex);
          }
        }
      }
    });
  }

  async createConnection(name: string, options?: { spendingLimitSats?: number; relayUrl?: string }): Promise<string> {
    const secretBytes = generateSecretKey();
    const secret = bytesToHex(secretBytes);
    const clientPubkey = getPublicKey(secretBytes);
    // Alby's relay is purpose-built for NWC; general relays (e.g. relay.damus.io)
    // rate-limit NWC traffic and drop pairings.
    const relayUrl = options?.relayUrl || "wss://relay.getalby.com/v1";
    const spendingLimitSats = options?.spendingLimitSats || 0;

    const connection: NwcConnection = {
      name,
      clientPubkey,
      secret,
      spendingLimitSats,
      spentTodaySats: 0,
      lastSpentTimestamp: Date.now(),
      createdAt: Date.now(),
      enabled: true,
      relayUrl
    };

    this.connections.push(connection);
    await this.saveConnections();

    // If manager is active, immediately establish relay socket connection and subscribe
    if (this.active) {
      this.connectRelay(relayUrl).catch((err) => {
        this.logger?.error(`Failed to connect to relay ${relayUrl} for new connection: ${err.message}`);
      });
    }

    const relayUrlEncoded = encodeURIComponent(relayUrl);
    return `nostr+walletconnect://${this.walletPubkey}?relay=${relayUrlEncoded}&secret=${secret}`;
  }

  async listConnections(): Promise<NwcConnection[]> {
    return this.connections;
  }

  async deleteConnection(clientPubkey: string): Promise<void> {
    const connToDelete = this.connections.find((c) => c.clientPubkey === clientPubkey);
    this.connections = this.connections.filter((c) => c.clientPubkey !== clientPubkey);
    await this.saveConnections();

    if (connToDelete && this.active) {
      // If no other active connection uses this relayUrl, close it
      const stillUsingRelay = this.connections.some((c) => c.enabled && c.relayUrl === connToDelete.relayUrl);
      if (!stillUsingRelay) {
        const sub = this.subs.get(connToDelete.relayUrl);
        if (sub) {
          sub.close();
          this.subs.delete(connToDelete.relayUrl);
        }
        const relay = this.relays.get(connToDelete.relayUrl);
        if (relay) {
          relay.close();
          this.relays.delete(connToDelete.relayUrl);
        }
      }
    }
  }

  async updateConnection(clientPubkey: string, updates: Partial<NwcConnection>): Promise<void> {
    this.connections = this.connections.map((c) => {
      if (c.clientPubkey === clientPubkey) {
        return { ...c, ...updates };
      }
      return c;
    });
    await this.saveConnections();
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;

    const uniqueRelays = Array.from(new Set(this.connections.filter((c) => c.enabled).map((c) => c.relayUrl)));
    for (const url of uniqueRelays) {
      this.connectRelay(url).catch((err) => {
        this.logger?.error(`Failed to connect to relay ${url}: ${err.message}`);
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;

    for (const sub of this.subs.values()) {
      try {
        sub.close();
      } catch (e) {}
    }
    this.subs.clear();

    for (const relay of this.relays.values()) {
      try {
        relay.close();
      } catch (e) {}
    }
    this.relays.clear();
  }

  private async saveConnections(): Promise<void> {
    await this.storage.setItem("nwc_connections", JSON.stringify(this.connections));
  }

  private async connectRelay(relayUrl: string): Promise<void> {
    if (this.relays.has(relayUrl)) return;

    this.logger?.info(`[NWC] Connecting to Nostr relay: ${relayUrl}`);
    const relay = await Relay.connect(relayUrl);
    this.relays.set(relayUrl, relay);

    // Publish NIP-47 info event (kind 13194) to advertise supported methods
    try {
      const infoEvent = finalizeEvent({
        kind: 13194,
        content: "pay_invoice pay_keysend make_invoice get_balance get_info",
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      }, hexToBytes(this.walletPrivKeyHex!));
      await relay.publish(infoEvent);
      this.logger?.info(`[NWC] Published NIP-47 info event (kind 13194) to ${relayUrl}`);
    } catch (err: any) {
      this.logger?.error(`[NWC] Failed to publish NIP-47 info event to ${relayUrl}: ${err.message}`);
    }

    const sub = relay.subscribe([
      {
        kinds: [23194],
        "#p": [this.walletPubkey!],
      }
    ], {
      onevent: async (event) => {
        try {
          await this.handleNwcRequest(event, relayUrl);
        } catch (err: any) {
          this.logger?.error(`Error handling NWC request event: ${err.message}`);
        }
      },
      onclose: (reason) => {
        this.logger?.warn(`[NWC] Subscription closed for relay ${relayUrl}: ${reason}`);
      }
    });

    this.subs.set(relayUrl, sub);
  }

  private async handleNwcRequest(event: any, relayUrl: string): Promise<void> {
    // Serialize requests per client so the spending-limit check-and-update is atomic —
    // concurrent requests from one client must not both pass the limit check before
    // either records its spend (TOCTOU race).
    const key = event.pubkey;
    const prev = this.requestChains.get(key) ?? Promise.resolve();
    const run = prev.then(() => this.processNwcRequest(event, relayUrl));
    this.requestChains.set(key, run.catch(() => {}));
    return run;
  }

  private async processNwcRequest(event: any, relayUrl: string): Promise<void> {
    // 1. Locate connection object
    const pairing = this.connections.find((c) => c.clientPubkey === event.pubkey && c.enabled);
    if (!pairing) {
      this.logger?.warn(`[NWC] Ignoring request from unauthorized or disabled sender: ${event.pubkey}`);
      return;
    }

    // 2. Decrypt NIP-04 content
    let plaintext: string;
    try {
      plaintext = await nip04.decrypt(this.walletPrivKeyHex!, event.pubkey, event.content);
    } catch (e) {
      this.logger?.error(`[NWC] Cryptographic decryption failed for request: ${e}`);
      return;
    }

    // 3. Parse JSON-RPC
    let rpcReq: any;
    try {
      rpcReq = JSON.parse(plaintext);
    } catch (e) {
      await this.sendErrorResponse(event, "BAD_REQUEST", "Invalid JSON format", relayUrl);
      return;
    }

    // 4. Validate schema
    const parseResult = nwcRequestSchema.safeParse(rpcReq);
    if (!parseResult.success) {
      await this.sendErrorResponse(event, "INVALID_PARAMS", parseResult.error.message, relayUrl, rpcReq.id);
      return;
    }

    const request = parseResult.data;
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    // Reset daily limits if 24 hours have passed
    let spentToday = pairing.spentTodaySats;
    if (now - pairing.lastSpentTimestamp >= oneDayMs) {
      spentToday = 0;
      pairing.spentTodaySats = 0;
      pairing.lastSpentTimestamp = now;
      await this.saveConnections();
    }

    try {
      if (request.method === "get_info") {
        const mgr = this.wallet.getChannelManager();
        if (!mgr) throw new Error("ChannelManager not available");
        const bestBlock = mgr.current_best_block();

        const result = {
          alias: "Libre Listener Wallet",
          color: "#3399ff",
          pubkey: bytesToHex(mgr.get_our_node_id()),
          // NIP-47 expects mainnet/testnet/signet/regtest (not "bitcoin").
          network: this.network,
          block_height: bestBlock.get_height(),
          // Block hashes are displayed big-endian; LDK returns internal little-endian.
          block_hash: bytesToHex(Uint8Array.from(bestBlock.get_block_hash()).reverse()),
          methods: ["pay_invoice", "pay_keysend", "make_invoice", "get_balance", "get_info"]
        };
        await this.sendResultResponse(event, "get_info", result, relayUrl, rpcReq.id);

      } else if (request.method === "get_balance") {
        const mgr = this.wallet.getChannelManager();
        if (!mgr) throw new Error("ChannelManager not available");
        const channels = mgr.list_channels();
        let balanceMsat = 0n;
        for (const chan of channels) {
          balanceMsat += chan.get_outbound_capacity_msat();
        }
        await this.sendResultResponse(event, "get_balance", { balance: Number(balanceMsat) }, relayUrl, rpcReq.id);

      } else if (request.method === "make_invoice") {
        const amountMsat = BigInt(request.params.amount);
        const description = request.params.description || "";
        const expiry = request.params.expiry || 3600;

        // The wallet owns the single invoice builder (it persists the preimage for claims).
        const invoiceStr = await this.wallet.createInvoice(Number(amountMsat / 1000n), description, expiry);
        const parsed = Bolt11Invoice.constructor_from_str(invoiceStr);
        if (!parsed.is_ok()) throw new Error("Failed to parse created invoice");
        const paymentHashHex = bytesToHex((parsed as any).res.payment_hash());

        const result = {
          type: "incoming",
          invoice: invoiceStr,
          description,
          description_hash: request.params.description_hash || "",
          // The preimage is a claim secret for an as-yet-unpaid invoice — it is
          // persisted locally (preimage_<hash>) for the claim path but must NEVER
          // leave the sandbox over the relay (key-isolation guardrail).
          payment_hash: paymentHashHex,
          amount: Number(amountMsat),
          fees_paid: 0,
          created_at: Math.floor(Date.now() / 1000),
          expires_at: Math.floor(Date.now() / 1000) + expiry,
        };
        await this.sendResultResponse(event, "make_invoice", result, relayUrl, rpcReq.id);

      } else if (request.method === "pay_invoice") {
        const invoiceStr = request.params.invoice;
        const invoiceRes = Bolt11Invoice.constructor_from_str(invoiceStr);
        if (!invoiceRes.is_ok()) {
          await this.sendErrorResponse(event, "INVALID_PARAMS", "Invalid Bolt11 invoice payload", relayUrl, rpcReq.id);
          return;
        }
        const invoice = (invoiceRes as any).res;
        const amtOpt = invoice.amount_milli_satoshis();
        if (!(amtOpt instanceof Option_u64Z_Some)) {
          await this.sendErrorResponse(event, "INVALID_PARAMS", "Zero-amount invoices not supported yet", relayUrl, rpcReq.id);
          return;
        }
        const amtSats = Number(amtOpt.some / 1000n);

        // Verify daily spending limits
        if (pairing.spendingLimitSats > 0 && spentToday + amtSats > pairing.spendingLimitSats) {
          await this.sendErrorResponse(event, "QUOTA_EXCEEDED", "Daily spending limit exceeded", relayUrl, rpcReq.id);
          return;
        }

        const paramRes = UtilMethods.constructor_payment_parameters_from_invoice(invoice);
        if (!paramRes.is_ok()) {
          throw new Error("Failed to construct LDK payment parameters from invoice");
        }
        const tuple = (paramRes as Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK).res;
        const paymentHash = tuple.get_a();
        const onionFields = tuple.get_b();
        const routeParams = tuple.get_c();

        const paymentId = getSecureRandomBytes(32);
        const retryStrategy = Retry.constructor_attempts(10);

        const promise = new Promise<string>((resolve, reject) => {
          this.pendingPayments.set(bytesToHex(paymentHash), { resolve, reject });
        });

        const sendRes = this.wallet.getChannelManager()!.send_payment(
          paymentHash,
          onionFields,
          paymentId,
          routeParams,
          retryStrategy
        );

        if (!sendRes.is_ok()) {
          this.pendingPayments.delete(bytesToHex(paymentHash));
          throw new Error(`LDK send_payment failed: ${(sendRes as any).err?.toString() || "Route not found"}`);
        }

        const preimageHex = await promise;

        // Update spent quota
        pairing.spentTodaySats = spentToday + amtSats;
        pairing.lastSpentTimestamp = now;
        await this.saveConnections();

        await this.sendResultResponse(event, "pay_invoice", { preimage: preimageHex }, relayUrl, rpcReq.id);

      } else if (request.method === "pay_keysend") {
        const destinationPubkey = request.params.pubkey;
        const amountMsat = BigInt(request.params.amount);
        const amtSats = Number(amountMsat / 1000n);

        // Verify daily spending limits
        if (pairing.spendingLimitSats > 0 && spentToday + amtSats > pairing.spendingLimitSats) {
          await this.sendErrorResponse(event, "QUOTA_EXCEEDED", "Daily spending limit exceeded", relayUrl, rpcReq.id);
          return;
        }

        // Use the client-supplied preimage or generate one; knowing the hash lets us register
        // the settlement waiter BEFORE initiating (no race with Event_PaymentSent).
        const keysendPreimage = request.params.preimage ? hexToBytes(request.params.preimage) : getSecureRandomBytes(32);
        const keysendHashHex = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", keysendPreimage as any)));

        // Map NWC tlv_records (hex values) to the wallet's customRecords (raw bytes).
        const customRecords: Record<number, Uint8Array> = {};
        if (request.params.tlv_records) {
          for (const item of request.params.tlv_records) customRecords[item.type] = hexToBytes(item.value);
        }

        const settled = new Promise<string>((resolve, reject) => {
          this.pendingPayments.set(keysendHashHex, { resolve, reject });
        });

        // The wallet owns the keysend construction (TLVs, onion, route, send).
        const sendRes = await this.wallet.sendKeysendPayment({
          destinationPubkey,
          amountSats: amtSats,
          customRecords,
          preimage: keysendPreimage,
        });
        if (!sendRes.ok) {
          this.pendingPayments.delete(keysendHashHex);
          throw new Error(`Keysend failed to initiate: ${sendRes.error}`);
        }

        const preimageHex = await settled;

        // Update spent quota
        pairing.spentTodaySats = spentToday + amtSats;
        pairing.lastSpentTimestamp = now;
        await this.saveConnections();

        await this.sendResultResponse(event, "pay_keysend", { preimage: preimageHex }, relayUrl, rpcReq.id);
      }
    } catch (err: any) {
      await this.sendErrorResponse(event, "INTERNAL_ERROR", err.message || "Failed to execute request", relayUrl, rpcReq.id);
    }
  }

  private async sendResultResponse(
    requestEvent: any,
    resultType: string,
    result: any,
    relayUrl: string,
    id?: string | number
  ): Promise<void> {
    const relay = this.relays.get(relayUrl);
    if (!relay) return;

    const plaintext = JSON.stringify({
      jsonrpc: "2.0",
      id: id || null,
      result_type: resultType,
      result,
    });

    const encrypted = await nip04.encrypt(this.walletPrivKeyHex!, requestEvent.pubkey, plaintext);

    const event = finalizeEvent({
      kind: 23195,
      tags: [
        ["p", requestEvent.pubkey],
        ["e", requestEvent.id],
      ],
      content: encrypted,
      created_at: Math.floor(Date.now() / 1000),
    }, hexToBytes(this.walletPrivKeyHex!));

    await relay.publish(event);
    this.notifyRequestProcessed(requestEvent.id, resultType, true);
  }

  private async sendErrorResponse(
    requestEvent: any,
    code: string,
    message: string,
    relayUrl: string,
    id?: string | number
  ): Promise<void> {
    const relay = this.relays.get(relayUrl);
    if (!relay) return;

    const plaintext = JSON.stringify({
      jsonrpc: "2.0",
      id: id || null,
      error: {
        code,
        message,
      },
    });

    const encrypted = await nip04.encrypt(this.walletPrivKeyHex!, requestEvent.pubkey, plaintext);

    const event = finalizeEvent({
      kind: 23195,
      tags: [
        ["p", requestEvent.pubkey],
        ["e", requestEvent.id],
      ],
      content: encrypted,
      created_at: Math.floor(Date.now() / 1000),
    }, hexToBytes(this.walletPrivKeyHex!));

    await relay.publish(event);
    this.notifyRequestProcessed(requestEvent.id, "", false, message);
  }
}
