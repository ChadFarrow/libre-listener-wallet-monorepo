import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip04,
  Relay,
  type VerifiedEvent
} from "nostr-tools";
import { z } from "zod";
import {
  nwcRequestSchema,
  NwcConnection,
  NWCRequestInput,
  NwcMethod,
  BudgetRenewal,
  budgetWindowElapsed,
  NWC_ALWAYS_ALLOWED_METHODS,
  paymentRecordsToNwcTransactions,
  buildGatewayAuthTemplate
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
  Event_PaymentFailed,
  Event_PaymentClaimed
} from "lightningdevkit";
import { bytesToHex, hexToBytes } from "./storage-cache";
import { getSecureRandomBytes } from "./crypto-utils";
import { reconnectDelayMs } from "./peer-reconnect";
import type { LibreListenerWallet, Logger, SecureStorageProvider } from "./index";

// Cap on remembered request event ids (FIFO eviction). Bounds memory while still
// catching the realistic duplicates: a relay redelivering recent events on resubscribe.
const MAX_HANDLED_EVENT_IDS = 2000;

// Cap how long a pay request blocks awaiting settlement. Generous (normal multi-hop
// settles in seconds) so the synchronous response still works for healthy payments; the
// timeout is a safety valve so a stuck HTLC can't freeze the per-client request chain.
// A late settlement after this still reaches the client via the payment_sent notification.
const SETTLEMENT_TIMEOUT_MS = 90_000;
const SETTLEMENT_TIMEOUT_MSG = "Payment initiated but not yet settled; you'll be notified when it completes.";

// Max standing NWC pairings. Each is a spend authority, so the count is bounded as hygiene against
// unbounded growth (a runaway UI, abuse) — not a scaling limit (all pairings share one relay socket).
// A person connects a handful of apps; 10 is generous while still a firm ceiling.
const MAX_NWC_CONNECTIONS = 10;

// Reject request events older than this (seconds). NIP-47 requests are ephemeral and acted
// on in near-real-time; a relay redelivering an OLD event after a restart (in-memory dedup
// forgotten) — or an observer replaying a captured, still-signed pay_* event — must not be
// re-executed, or it pays twice (LDK dedups sends by a random paymentId, not the payment
// hash, so a bolt11 replay isn't caught downstream). Generous window tolerates clock skew.
const NWC_REQUEST_MAX_AGE_SEC = 300;

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
  // Who initiated each outbound payment (by payment-hash hex), so we can send a NIP-47
  // payment_sent notification on settlement — even if the synchronous response already
  // timed out on the client. This is what clears the false "timeout" failure in apps.
  private paymentContexts: Map<string, { clientPubkey: string; relayUrl: string; amountMsat: number }> = new Map();
  // Which client created each invoice (by payment-hash hex), so an inbound claim notifies
  // the make_invoice requester with a NIP-47 payment_received notification.
  private invoiceContexts: Map<string, { clientPubkey: string; relayUrl: string; expiresAt: number }> = new Map();
  private active: boolean = false;
  // Per-client request serialization so the spending-limit check-and-update is atomic.
  private requestChains: Map<string, Promise<void>> = new Map();
  // The wallet event listener, registered once (see init) so restarts don't stack duplicates.
  private walletEventListener?: (event: Event) => void;
  // Request event ids already handled, so a redelivered event (e.g. on resubscribe
  // after a reconnect) is not processed — and paid — twice. FIFO-bounded.
  private handledEventIds: Set<string> = new Set();
  private handledEventOrder: string[] = [];
  // Relay auto-reconnect: a dropped relay otherwise silently stops NWC requests
  // until a full node restart. Redial with exponential backoff while active.
  private reconnectAttempts: Map<string, number> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
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

  /**
   * Build a signed Nostr event that proves control of this wallet's pubkey when registering /
   * unregistering a Web Push subscription with the gateway. The gateway can't tell the real owner
   * of a (public) walletPubkey from an impersonator without this — the private key never leaves
   * the sandbox; only the signature does. The event commits to the action, the relay, and (for a
   * register) the push endpoint, and carries a fresh created_at, so a captured event can't be
   * replayed to a different action/relay/endpoint or reused after it expires. NIP-98-style; the
   * wire contract (kind, tags, content) is @libre/shared gateway-auth.ts, shared with the verifier.
   */
  buildGatewayAuth(action: "register" | "unregister", relayUrl: string, endpoint?: string): VerifiedEvent {
    if (!this.walletPrivKeyHex) throw new Error("NWC not initialized: cannot sign gateway auth");
    return finalizeEvent(
      buildGatewayAuthTemplate(action, relayUrl, endpoint, Math.floor(Date.now() / 1000)),
      hexToBytes(this.walletPrivKeyHex),
    );
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

    // Load active pairings, dropping any that have expired (dead — they can't be used again).
    const connJson = await storage.getItem("nwc_connections");
    this.connections = connJson ? JSON.parse(connJson) as NwcConnection[] : [];
    await this.pruneExpiredConnections();

    // Register the LDK event listener ONCE. init() is called on every wallet start(); without
    // this guard each restart stacks another listener on the wallet, and every LDK event then
    // fires N settlement handlers (the first delete wins, but the duplicates are wasted work and
    // a slow leak). The closure only touches persistent NwcManager state, so registering once is safe.
    if (!this.walletEventListener) {
      this.walletEventListener = (event: Event) => {
        // Keep the LDK `instanceof` checks in this thin edge; the testable logic lives in
        // handlePaymentSettled/handlePaymentFailed (so notifications are unit-testable
        // without a real payment).
        if (event instanceof Event_PaymentSent) {
          const hashHex = bytesToHex(event.payment_hash);
          const preimageHex = bytesToHex(event.payment_preimage);
          const feePaidMsat = event.fee_paid_msat instanceof Option_u64Z_Some ? Number(event.fee_paid_msat.some) : 0;
          void this.handlePaymentSettled(hashHex, preimageHex, feePaidMsat);
        } else if (event instanceof Event_PaymentFailed) {
          if (event.payment_hash instanceof Option_ThirtyTwoBytesZ_Some) {
            this.handlePaymentFailed(bytesToHex(event.payment_hash.some));
          }
        } else if (event instanceof Event_PaymentClaimed) {
          void this.handlePaymentReceived(bytesToHex(event.payment_hash), Number(event.amount_msat));
        }
      };
      this.wallet.addEventListener(this.walletEventListener);
    }
  }

  /**
   * A tracked outbound payment settled. Resolve any synchronous waiter AND publish a
   * NIP-47 `payment_sent` notification to the initiating client — the notification fires
   * independently, so a client whose request already timed out still learns it succeeded.
   */
  private async handlePaymentSettled(paymentHashHex: string, preimageHex: string, feePaidMsat: number): Promise<void> {
    const resolver = this.pendingPayments.get(paymentHashHex);
    if (resolver) {
      resolver.resolve(preimageHex);
      this.pendingPayments.delete(paymentHashHex);
    }
    const ctx = this.paymentContexts.get(paymentHashHex);
    if (ctx) {
      this.paymentContexts.delete(paymentHashHex);
      try {
        await this.sendNotification(ctx.clientPubkey, ctx.relayUrl, "payment_sent", {
          payment_hash: paymentHashHex,
          preimage: preimageHex,
          amount: ctx.amountMsat,
          fees_paid: feePaidMsat,
        });
      } catch (e: any) {
        this.logger?.error(`[NWC] Failed to publish payment_sent notification: ${e?.message || e}`);
      }
    }
  }

  /**
   * Reverse an optimistic budget debit for a payment that definitively failed to initiate
   * or settle. Uses a subtract-from-current (clamped ≥0) so it composes correctly rather
   * than resetting to a possibly-stale snapshot. See the pay_invoice/pay_keysend debit sites.
   */
  private async refundBudget(pairing: NwcConnection, amtSats: number): Promise<void> {
    pairing.spentTodaySats = Math.max(0, pairing.spentTodaySats - amtSats);
    await this.saveConnections();
  }

  /**
   * Debit the budget at INITIATION, not after the settlement await. A payment that outlives
   * the 90s await is still in flight and usually settles (the client then learns of it via the
   * payment_sent notification); charging only on the synchronous resolve let a client repeatedly
   * spend past its cap using slow/hodl payments that always time out. The initiation/settlement
   * failure paths refund via refundBudget.
   */
  private async debitBudget(pairing: NwcConnection, spentToday: number, amtSats: number, now: number): Promise<void> {
    pairing.spentTodaySats = spentToday + amtSats;
    pairing.lastSpentTimestamp = now;
    await this.saveConnections();
  }

  /**
   * The ONE settle-or-refund policy for pay_invoice AND pay_keysend (a fund-handling rule that
   * must not drift between them): await settlement under the 90s cap; a definitive
   * PaymentFailed → the money didn't move, refund the debit; a bare timeout → the payment is
   * still in flight, KEEP the charge (anti-replay — see debitBudget). The timeout is
   * discriminated by error IDENTITY (we made the object), never by message text.
   */
  private async awaitSettlementCharged(pairing: NwcConnection, amtSats: number, settled: Promise<string>): Promise<string> {
    const timeoutError = new Error(SETTLEMENT_TIMEOUT_MSG);
    try {
      return await this.awaitWithTimeout(settled, SETTLEMENT_TIMEOUT_MS, timeoutError);
    } catch (settleErr) {
      if (settleErr !== timeoutError) {
        await this.refundBudget(pairing, amtSats);
      }
      throw settleErr;
    }
  }

  /** True when a pairing carries an expiry (epoch ms) that has passed. */
  private static isConnectionExpired(c: NwcConnection, now: number): boolean {
    return !!c.expiresAt && now >= c.expiresAt;
  }

  /** Drop invoice contexts whose invoice has expired (they can no longer be claimed). */
  private pruneExpiredInvoiceContexts(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [hash, ctx] of this.invoiceContexts) {
      if (ctx.expiresAt < now) this.invoiceContexts.delete(hash);
    }
  }

  /** A tracked outbound payment failed. Reject any waiter and drop its notification context. */
  private handlePaymentFailed(paymentHashHex: string): void {
    const resolver = this.pendingPayments.get(paymentHashHex);
    if (resolver) {
      resolver.reject(new Error("LDK payment execution failed"));
      this.pendingPayments.delete(paymentHashHex);
    }
    this.paymentContexts.delete(paymentHashHex);
  }

  /**
   * An inbound payment was claimed. If it settles an invoice a NWC client created via
   * make_invoice, publish a NIP-47 `payment_received` notification to that client.
   * (Preimage is intentionally omitted — the key-isolation guardrail keeps claim secrets
   * off the relay.)
   */
  private async handlePaymentReceived(paymentHashHex: string, amountMsat: number): Promise<void> {
    const ctx = this.invoiceContexts.get(paymentHashHex);
    if (!ctx) return;
    this.invoiceContexts.delete(paymentHashHex);
    try {
      await this.sendNotification(ctx.clientPubkey, ctx.relayUrl, "payment_received", {
        type: "incoming",
        payment_hash: paymentHashHex,
        amount: amountMsat,
        fees_paid: 0,
      });
    } catch (e: any) {
      this.logger?.error(`[NWC] Failed to publish payment_received notification: ${e?.message || e}`);
    }
  }

  /**
   * Await a settlement promise but give up after `ms` so a hung payment can't block the
   * per-client request chain forever. On timeout the (still-pending) payment is left in
   * flight — a late settlement still resolves it and fires the payment_sent notification.
   */
  private awaitWithTimeout<T>(p: Promise<T>, ms: number, timeoutError: Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(timeoutError), ms);
      p.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  async createConnection(
    name: string,
    options?: {
      spendingLimitSats?: number;
      relayUrl?: string;
      budgetRenewal?: BudgetRenewal;
      maxAmountSats?: number;
      allowedMethods?: NwcMethod[];
      expiresAt?: number;
    }
  ): Promise<string> {
    // Drop dead (expired) pairings first — they can never be used again and shouldn't occupy a slot
    // — then enforce the cap on what remains.
    await this.pruneExpiredConnections();
    if (this.connections.length >= MAX_NWC_CONNECTIONS) {
      throw new Error(
        `NWC connection limit reached (${MAX_NWC_CONNECTIONS}). Remove an existing connection before adding another.`,
      );
    }

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
      relayUrl,
      // Only persist the new controls when a caller sets them, so a connection
      // created without them keeps the legacy shape (daily budget, all methods,
      // no per-payment cap, no expiry).
      ...(options?.budgetRenewal ? { budgetRenewal: options.budgetRenewal } : {}),
      ...(options?.maxAmountSats ? { maxAmountSats: options.maxAmountSats } : {}),
      ...(options?.allowedMethods ? { allowedMethods: options.allowedMethods } : {}),
      ...(options?.expiresAt ? { expiresAt: options.expiresAt } : {}),
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

  /** Drop pairings whose expiry has passed (they're already rejected at request time and can never
   *  be used again, so they shouldn't count toward the connection cap). Persists only if it changed. */
  private async pruneExpiredConnections(): Promise<void> {
    const now = Date.now();
    const before = this.connections.length;
    this.connections = this.connections.filter((c) => !NwcManager.isConnectionExpired(c, now));
    if (this.connections.length !== before) {
      this.logger?.info(`[NWC] Pruned ${before - this.connections.length} expired connection(s)`);
      await this.saveConnections();
    }
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

    // Cancel any pending relay redials so a backoff timer can't fire after stop.
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();

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
    // A connection succeeded — reset the backoff for this relay.
    this.reconnectAttempts.delete(relayUrl);

    // Publish NIP-47 info event (kind 13194) to advertise supported methods
    try {
      const infoEvent = finalizeEvent({
        kind: 13194,
        content: "pay_invoice pay_keysend make_invoice get_balance get_info notifications",
        // NIP-47: supported notification types are listed in a `notifications` tag so
        // clients know to subscribe for async settlement updates.
        tags: [["notifications", "payment_sent payment_received"]],
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
        // The relay connection dropped. Drop the stale handles and redial with
        // backoff while active, so we don't silently stop receiving NWC requests.
        this.relays.delete(relayUrl);
        this.subs.delete(relayUrl);
        this.scheduleRelayReconnect(relayUrl);
      }
    });

    this.subs.set(relayUrl, sub);
  }

  private scheduleRelayReconnect(relayUrl: string): void {
    if (!this.active) return;
    if (this.reconnectTimers.has(relayUrl)) return; // a redial is already pending
    // Only redial a relay an enabled connection still needs.
    const stillNeeded = this.connections.some((c) => c.enabled && c.relayUrl === relayUrl);
    if (!stillNeeded) return;

    const attempt = (this.reconnectAttempts.get(relayUrl) ?? 0) + 1;
    this.reconnectAttempts.set(relayUrl, attempt);
    const delay = reconnectDelayMs(attempt);
    this.logger?.info(`[NWC] Relay ${relayUrl} dropped; reconnecting in ${delay}ms (attempt ${attempt})`);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(relayUrl);
      if (!this.active) return;
      this.connectRelay(relayUrl).catch((err: any) => {
        this.logger?.error(`[NWC] Relay reconnect to ${relayUrl} failed: ${err?.message || err}`);
        this.scheduleRelayReconnect(relayUrl);
      });
    }, delay);
    this.reconnectTimers.set(relayUrl, timer);
  }

  private markEventHandled(eventId: string): void {
    this.handledEventIds.add(eventId);
    this.handledEventOrder.push(eventId);
    if (this.handledEventOrder.length > MAX_HANDLED_EVENT_IDS) {
      const evicted = this.handledEventOrder.shift()!;
      this.handledEventIds.delete(evicted);
    }
  }

  private async handleNwcRequest(event: any, relayUrl: string): Promise<void> {
    // Reject stale requests before anything else. A signed event carries its original
    // created_at (you can't alter it without breaking the signature), so a replayed/redelivered
    // pay_* event is caught here even after a restart wipes the in-memory dedup set. Events
    // with no created_at (only synthetic/test events — a relay-delivered event always has one)
    // skip the check so they aren't spuriously dropped.
    const createdAt = typeof event?.created_at === "number" ? event.created_at : 0;
    if (createdAt > 0) {
      const ageSec = Math.floor(Date.now() / 1000) - createdAt;
      if (ageSec > NWC_REQUEST_MAX_AGE_SEC) {
        this.logger?.warn(`[NWC] Ignoring stale request event ${event?.id} (created_at age ${ageSec}s)`);
        return;
      }
    }

    // Deduplicate by event id. The same request can be delivered more than once (a relay
    // redelivering recent events on resubscribe after a reconnect); processing a pay_*
    // request twice would pay twice. The check-and-mark is synchronous (no await before
    // markEventHandled) so two near-simultaneous deliveries can't both slip through.
    const eventId = event?.id;
    if (eventId) {
      if (this.handledEventIds.has(eventId)) {
        this.logger?.info(`[NWC] Ignoring duplicate request event ${eventId}`);
        return;
      }
      this.markEventHandled(eventId);
    }

    // Serialize the spending-limit check-and-debit per client so it stays atomic —
    // concurrent requests from one client must not both pass the limit check before either
    // records its spend (TOCTOU race). But gate the NEXT request only on THIS one's budget
    // RESERVATION (check + debit + initiation), NOT its settlement: a V4V boost arrives as a
    // burst of pay_keysend requests from one client, and holding the serialization lock through
    // each settlement await (up to 90s) made later splits wait behind every prior settlement,
    // blow the client's request timeout, and surface as "failed" though they actually settled.
    const key = event.pubkey;
    const prev = this.requestChains.get(key) ?? Promise.resolve();
    let releaseReserved!: () => void;
    const reserved = new Promise<void>((res) => { releaseReserved = res; });
    // Full processing (may await settlement) still runs after the previous request has at least
    // reserved its budget, so the debit ordering is preserved.
    const run = prev.then(() => this.processNwcRequest(event, relayUrl, releaseReserved));
    // Belt-and-suspenders: always release the gate when processing ends, covering every exit
    // that didn't explicitly signal (early rejections, throws before the debit).
    void run.catch(() => {}).finally(() => releaseReserved());
    // The next request queues behind this request's RESERVATION, not its settlement.
    this.requestChains.set(key, reserved);
    // Drop the entry once this client's queue drains, so the map can't grow one permanent entry
    // per (unauthenticated) sender pubkey over a long-lived session. Only delete if we're still
    // the tail — a newer request may have replaced us.
    void reserved.finally(() => {
      if (this.requestChains.get(key) === reserved) this.requestChains.delete(key);
    });
    return run;
  }

  private async processNwcRequest(event: any, relayUrl: string, signalReserved: () => void = () => {}): Promise<void> {
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

    // Reject an expired connection before doing any work.
    if (NwcManager.isConnectionExpired(pairing, now)) {
      await this.sendErrorResponse(event, "UNAUTHORIZED", "This connection has expired", relayUrl, rpcReq.id);
      return;
    }

    // Enforce the per-connection method allowlist. `get_info` and `list_transactions`
    // are always permitted (a handshake capability and read-only history — neither
    // exposes funds, so Alby Go gets history regardless of a pairing's spend allowlist);
    // every other method must be in the allowlist when one is set. An undefined allowlist
    // means "all methods" (legacy connections).
    if (
      pairing.allowedMethods &&
      !(NWC_ALWAYS_ALLOWED_METHODS as readonly string[]).includes(request.method) &&
      !pairing.allowedMethods.includes(request.method as NwcMethod)
    ) {
      await this.sendErrorResponse(event, "RESTRICTED", `Method ${request.method} is not permitted for this connection`, relayUrl, rpcReq.id);
      return;
    }

    // Reset the spending budget if its renewal window has elapsed.
    let spentToday = pairing.spentTodaySats;
    if (budgetWindowElapsed(pairing.budgetRenewal, pairing.lastSpentTimestamp, now)) {
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

        // Advertise only the methods this connection is actually permitted to use
        // (get_info is always available). An undefined allowlist means all methods.
        const grantable = ["get_balance", "make_invoice", "pay_invoice", "pay_keysend"];
        const permitted = pairing.allowedMethods
          ? grantable.filter((m) => pairing.allowedMethods!.includes(m as NwcMethod))
          : grantable;

        const result = {
          alias: "Libre Listener Wallet",
          color: "#3399ff",
          pubkey: bytesToHex(mgr.get_our_node_id()),
          // NIP-47 expects mainnet/testnet/signet/regtest (not "bitcoin").
          network: this.network,
          block_height: bestBlock.get_height(),
          // Block hashes are displayed big-endian; LDK returns internal little-endian.
          block_hash: bytesToHex(Uint8Array.from(bestBlock.get_block_hash()).reverse()),
          // get_info + list_transactions are always available (see the allowlist gate).
          methods: [...permitted, "get_info", "list_transactions"],
          notifications: ["payment_sent", "payment_received"]
        };
        await this.sendResultResponse(event, "get_info", result, relayUrl, rpcReq.id);

      } else if (request.method === "get_balance") {
        const mgr = this.wallet.getChannelManager();
        if (!mgr) throw new Error("ChannelManager not available");
        const channels = mgr.list_channels();
        let balanceMsat = 0n;
        for (const chan of channels) {
          // Only count USABLE channels (matches the SDK's getBalance()). A ready-but-peer-offline
          // channel has outbound capacity but can't actually route, so reporting it here would tell
          // a client it can spend funds that the very next pay_invoice can't move.
          if (!chan.get_is_usable()) continue;
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
        // Remember which client created this invoice so an inbound claim notifies them. Drop any
        // expired contexts first so a client that mints many never-paid invoices can't grow this
        // map without bound (each entry is dead once its invoice expires and can't be claimed).
        this.pruneExpiredInvoiceContexts();
        this.invoiceContexts.set(paymentHashHex, {
          clientPubkey: event.pubkey,
          relayUrl,
          expiresAt: Math.floor(Date.now() / 1000) + expiry,
        });

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

        // Enforce the per-payment cap before the running budget.
        if (pairing.maxAmountSats && pairing.maxAmountSats > 0 && amtSats > pairing.maxAmountSats) {
          await this.sendErrorResponse(event, "QUOTA_EXCEEDED", `Payment exceeds the per-payment limit of ${pairing.maxAmountSats} sats`, relayUrl, rpcReq.id);
          return;
        }

        // Verify the budget spending limit
        if (pairing.spendingLimitSats > 0 && spentToday + amtSats > pairing.spendingLimitSats) {
          await this.sendErrorResponse(event, "QUOTA_EXCEEDED", "Spending budget exceeded", relayUrl, rpcReq.id);
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

        const payInvoiceHashHex = bytesToHex(paymentHash);
        const promise = new Promise<string>((resolve, reject) => {
          this.pendingPayments.set(payInvoiceHashHex, { resolve, reject });
        });
        this.paymentContexts.set(payInvoiceHashHex, { clientPubkey: event.pubkey, relayUrl, amountMsat: Number(amtOpt.some) });
        // Record the outbound intent so it shows in history with its amount (finalized on
        // Event_PaymentSent / Event_PaymentFailed by the SDK's payment-log listener).
        this.wallet.notePendingPayment({
          id: payInvoiceHashHex,
          direction: "sent",
          status: "pending",
          amountSats: amtSats,
          timestamp: Date.now(),
          type: "bolt11",
        });

        // Charge at initiation; refund on definitive failure only (see debitBudget /
        // awaitSettlementCharged — the shared policy, matching the extension's
        // settlement-pending semantics).
        await this.debitBudget(pairing, spentToday, amtSats, now);

        // Wait out a brief peer-reconnect window (resume-from-background) so the pay doesn't fail
        // RouteNotFound before the channel is usable again. pay_keysend gets this via
        // sendKeysendPayment; pay_invoice calls send_payment directly, so it needs the wait here.
        await this.wallet.waitForUsableChannel();

        const sendRes = this.wallet.getChannelManager()!.send_payment(
          paymentHash,
          onionFields,
          paymentId,
          routeParams,
          retryStrategy
        );

        if (!sendRes.is_ok()) {
          this.pendingPayments.delete(payInvoiceHashHex);
          this.paymentContexts.delete(payInvoiceHashHex);
          // Nothing left the node → NO LDK event will fire. Finalize the noted-pending record as
          // failed here, or it strands at "pending" forever in history (the stuck-PENDING bug).
          this.wallet.recordFailedPayment(payInvoiceHashHex);
          await this.refundBudget(pairing, amtSats); // never left the wallet — reverse the debit
          throw new Error(`LDK send_payment failed: ${(sendRes as any).err?.toString() || "Route not found"}`);
        }

        // Budget is reserved and the payment is in flight: release this client's serialization
        // gate so the next queued request can start, instead of holding it through settlement.
        signalReserved();

        const preimageHex = await this.awaitSettlementCharged(pairing, amtSats, promise);

        await this.sendResultResponse(event, "pay_invoice", { preimage: preimageHex }, relayUrl, rpcReq.id);

      } else if (request.method === "pay_keysend") {
        const destinationPubkey = request.params.pubkey;
        const amountMsat = BigInt(request.params.amount);
        const amtSats = Number(amountMsat / 1000n);

        // Enforce the per-payment cap before the running budget.
        if (pairing.maxAmountSats && pairing.maxAmountSats > 0 && amtSats > pairing.maxAmountSats) {
          await this.sendErrorResponse(event, "QUOTA_EXCEEDED", `Payment exceeds the per-payment limit of ${pairing.maxAmountSats} sats`, relayUrl, rpcReq.id);
          return;
        }

        // Verify the budget spending limit
        if (pairing.spendingLimitSats > 0 && spentToday + amtSats > pairing.spendingLimitSats) {
          await this.sendErrorResponse(event, "QUOTA_EXCEEDED", "Spending budget exceeded", relayUrl, rpcReq.id);
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
        this.paymentContexts.set(keysendHashHex, { clientPubkey: event.pubkey, relayUrl, amountMsat: Number(amountMsat) });

        // Charge at initiation; refund on definitive failure only (see debitBudget /
        // awaitSettlementCharged — the shared policy).
        await this.debitBudget(pairing, spentToday, amtSats, now);

        // The wallet owns the keysend construction (TLVs, onion, route, send).
        let sendRes: { ok: boolean; error?: string };
        try {
          sendRes = await this.wallet.sendKeysendPayment({
            destinationPubkey,
            amountSats: amtSats,
            customRecords,
            preimage: keysendPreimage,
          });
        } catch (initErr) {
          // sendKeysendPayment can throw (e.g. node not running) rather than return ok:false.
          this.pendingPayments.delete(keysendHashHex);
          this.paymentContexts.delete(keysendHashHex);
          await this.refundBudget(pairing, amtSats);
          throw initErr;
        }
        if (!sendRes.ok) {
          this.pendingPayments.delete(keysendHashHex);
          this.paymentContexts.delete(keysendHashHex);
          await this.refundBudget(pairing, amtSats); // never initiated — reverse the debit
          throw new Error(`Keysend failed to initiate: ${sendRes.error}`);
        }

        // Budget is reserved and the keysend is in flight: release this client's serialization
        // gate so the next split can start, instead of holding it through settlement (the burst
        // of boost splits is exactly why later ones were timing out client-side).
        signalReserved();

        // Ack on dispatch. We OWN the keysend preimage, so the client can be answered the moment
        // the payment is irrevocably in flight — no need to block on settlement like pay_invoice
        // (whose preimage is the payee's secret, revealed only on settlement). A browser LDK node
        // settles a boost burst slower than a client's (Alby Go's) request timeout, so waiting for
        // Event_PaymentSent made every boost surface as "Failed" even though it succeeded — the
        // client only learned of the settle via the async payment_sent notification, too late to
        // clear the already-failed request. Settlement is still tracked in the background: the
        // payment_sent notification fires on it (the real confirmation) and the optimistic budget
        // debit is refunded on a definitive failure. Trade-off: a keysend that later fails to
        // route was already reported sent — acceptable for tiny fire-and-forget V4V boosts, and
        // LDK retries the route up to 10× before giving up.
        void this.awaitSettlementCharged(pairing, amtSats, settled).catch(() => {
          // A definitive failure already refunded the debit inside; a bare timeout keeps the
          // charge (still in flight). Nothing to send here — the client was acked on dispatch,
          // and a late settle still delivers the payment_sent notification.
        });

        await this.sendResultResponse(event, "pay_keysend", { preimage: bytesToHex(keysendPreimage), fees_paid: 0 }, relayUrl, rpcReq.id);

      } else if (request.method === "list_transactions") {
        // Read-only history (Alby Go et al.). No spending-limit/budget checks. The wallet's
        // forward-only payment log is the source of truth; the pure mapper handles unit
        // conversions (sat→msat, ms→unix-seconds) and from/until/type/limit/offset filtering.
        const records = await this.wallet.getPayments();
        const transactions = paymentRecordsToNwcTransactions(records, request.params ?? {});
        await this.sendResultResponse(event, "list_transactions", { transactions }, relayUrl, rpcReq.id);
      }
    } catch (err: any) {
      await this.sendErrorResponse(event, "INTERNAL_ERROR", err.message || "Failed to execute request", relayUrl, rpcReq.id);
    }
  }

  /**
   * Publish a NIP-47 notification (kind 23196, NIP-04 encrypted) to a client. Unlike a
   * response, it carries no `e`-tag — it isn't tied to a specific request, which is exactly
   * why it can deliver a late settlement to a client that already gave up on its request.
   */
  private async sendNotification(
    clientPubkey: string,
    relayUrl: string,
    notificationType: string,
    notification: any
  ): Promise<void> {
    const relay = this.relays.get(relayUrl);
    if (!relay) return;

    const plaintext = JSON.stringify({ notification_type: notificationType, notification });
    const encrypted = await nip04.encrypt(this.walletPrivKeyHex!, clientPubkey, plaintext);

    const event = finalizeEvent({
      kind: 23196,
      tags: [["p", clientPubkey]],
      content: encrypted,
      created_at: Math.floor(Date.now() / 1000),
    }, hexToBytes(this.walletPrivKeyHex!));

    await relay.publish(event);
  }

  private async sendResultResponse(
    requestEvent: any,
    resultType: string,
    result: any,
    relayUrl: string,
    // Kept for call-site symmetry with sendErrorResponse; the response no longer echoes a content
    // id (NIP-47 correlates by the `e` tag). Underscore-prefixed so it's not flagged as unused.
    _id?: string | number
  ): Promise<void> {
    const relay = this.relays.get(relayUrl);
    if (!relay) return;

    // Match the NIP-47 response schema EXACTLY: only `result_type`, `error` (null on success —
    // required, not optional), and `result`. The old response also carried `jsonrpc`/`id`, which
    // are NOT part of NIP-47 (that's JSON-RPC 2.0, a different protocol); a strict client parser
    // (Alby Go 2.x) can reject a response with unexpected fields, marking a settled payment
    // "failed". Responses are correlated by the `e` tag (the request event id), never a content id.
    const plaintext = JSON.stringify({
      result_type: resultType,
      error: null,
      result,
    });
    // Diagnostic: log the exact response we publish so a "shows failed in the client" report can be
    // resolved from the wire bytes instead of guesswork.
    this.logger?.info(`[NWC] response → ${resultType}: ${plaintext}`);

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
    // Diagnostic: an error response is what makes a client show "failed" — log it so a report can
    // be traced to the code/message we actually sent.
    this.logger?.info(`[NWC] error response → ${code}: ${message}`);

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
