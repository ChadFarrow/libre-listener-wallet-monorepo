import type { PaymentRecord } from "@libre/shared";
import type { ControllerEvent } from "../wallet-controller";
import type { NwcConnectionView } from "./nwc-connection-view";
import type { PeerRow } from "./peer-list";
import { demoState } from "./demo-mode";

// A fake, in-memory WalletController stand-in for demo mode (?demo): every flow works and
// "just happens" — the node starts instantly, the LSP channel order auto-completes without
// payment, minted invoices pay themselves, sends settle after a beat — so the UI can be
// exercised end-to-end with zero setup and zero sats. Structurally compatible with the
// methods the screens call; never touches IndexedDB or the network.

const DEMO_SEED = "8f3a1c9e5b2d7f0a4e6c8b1d3f5a7c9e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a";
const DEMO_PHRASE =
  "ripple canyon velvet orbit lantern meadow copper drift summit ember willow harbor " +
  "quartz timber falcon prairie cinder marble hollow beacon tundra saddle juniper vault";
const DEMO_NODE_ID = "02fbc1a2d94e5b3c7f80a1e6c9b2d4f7a0c3e5b8d1f4a6c9e2b5d8f0a3c6e9b2d4";
const LSP_PUBKEY = "038a9e56512ec98da4b1fbcbc906bfd25bb1ff0b7ac00369686604131e4b1e2a37";
const FAKE_INVOICE_PREFIX = "lnbc1demo0invoice0not0payable0";

const CHANNEL_CAPACITY = 150_000;
const OPENING_FEE = 13_126;

interface DemoOrder {
  createdAt: number;
}

function fakeHash(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class DemoController {
  private emit: ControllerEvent;
  private hasWallet = false;
  private running = false;
  private channels = 0;
  private spendableSat = 0;
  private receivableSat = 0;
  private payments: PaymentRecord[] = [];
  private connections: NwcConnectionView[] = [
    {
      name: "stablekraft",
      clientPubkey: "ab".repeat(32),
      relayUrl: "wss://relay.getalby.com/v1",
      spendingLimitSats: 10_000,
      spentThisPeriodSats: 2_350,
      budgetRenewal: "daily",
      createdAt: Date.now() - 12 * 86_400_000,
    },
  ];
  private peers: PeerRow[] = [];
  private orders = new Map<string, DemoOrder>();
  private receiveTimer: ReturnType<typeof setTimeout> | undefined;
  private sweepAddress = "";

  constructor(emit: ControllerEvent = () => {}) {
    this.emit = emit;
  }

  private changed(): void {
    this.emit("state-changed");
  }

  isRunning(): boolean {
    return this.running;
  }

  async getState() {
    return {
      network: "demo",
      running: this.running,
      hasSeed: this.hasWallet,
      hasChannelState: this.channels > 0,
      createdNew: this.hasWallet,
      nodeId: this.running ? DEMO_NODE_ID : undefined,
      balance: this.running ? { spendableSat: this.spendableSat, receivableSat: this.receivableSat } : undefined,
      channels: this.running ? this.channels : undefined,
      usableChannels: this.running ? this.channels : undefined,
      peers: this.running ? this.peers.filter((p) => p.connected).length : undefined,
      startError: undefined as string | undefined,
    };
  }

  async createWallet(): Promise<{ seedHex: string; nodeId: string; network: string }> {
    this.hasWallet = true;
    this.running = true;
    this.peers = [
      { pubkey: LSP_PUBKEY, address: "143.42.101.77:9735", connected: true, hasChannel: false },
    ];
    this.changed();
    return { seedHex: DEMO_SEED, nodeId: DEMO_NODE_ID, network: "demo" };
  }

  async startNode(): Promise<{ nodeId: string; network: string }> {
    if (!this.hasWallet) throw new Error("No wallet — create one first (demo).");
    this.running = true;
    this.changed();
    return { nodeId: DEMO_NODE_ID, network: "demo" };
  }

  async stopNode(): Promise<void> {
    this.running = false;
    this.changed();
  }

  async autoStart(): Promise<void> {
    /* a fresh demo session starts with no wallet — onboarding owns the flow */
  }

  async resetWallet(): Promise<{ network: string }> {
    this.hasWallet = false;
    this.running = false;
    this.channels = 0;
    this.spendableSat = 0;
    this.receivableSat = 0;
    this.payments = [];
    this.orders.clear();
    demoState.seedBackedUp = false;
    demoState.driveConfigured = false;
    this.changed();
    return { network: "demo" };
  }

  async getSeed(): Promise<{ seedHex: string }> {
    return { seedHex: DEMO_SEED };
  }

  async getRecoveryPhrase(): Promise<{ mnemonic: string }> {
    return { mnemonic: DEMO_PHRASE };
  }

  async restoreWallet(): Promise<never> {
    throw new Error("Restore isn't available in demo mode — exit demo to use your real wallet.");
  }

  async exportBackup(): Promise<never> {
    throw new Error("Backups aren't available in demo mode.");
  }

  // Minted invoices pay themselves after a few seconds so balance + history visibly move.
  async createInvoice(amountSats: number): Promise<{ paymentRequest: string }> {
    if (!this.running) throw new Error("Wallet is not running");
    const amt = Math.floor(Number(amountSats));
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter an amount in sats greater than 0.");
    clearTimeout(this.receiveTimer);
    this.receiveTimer = setTimeout(() => {
      if (!this.running || this.channels === 0) return;
      this.spendableSat += amt;
      this.receivableSat = Math.max(0, this.receivableSat - amt);
      this.payments.unshift({
        id: fakeHash(),
        direction: "received",
        status: "settled",
        amountSats: amt,
        timestamp: Date.now(),
        settledAt: Date.now(),
        note: "Demo top-up",
      });
      this.changed();
    }, 6000);
    return { paymentRequest: `${FAKE_INVOICE_PREFIX}${amt}sats${fakeHash().slice(0, 40)}` };
  }

  async getPayments(): Promise<PaymentRecord[]> {
    return [...this.payments];
  }

  async payLightning(input: string, opts?: { amountSats?: number }): Promise<{ preimage: string; amountSats: number }> {
    if (!this.running) throw new Error("Wallet is not running");
    const amt = Math.floor(Number(opts?.amountSats ?? 100));
    const rec: PaymentRecord = {
      id: fakeHash(),
      direction: "sent",
      status: "pending",
      amountSats: amt,
      timestamp: Date.now(),
      type: input.includes("@") ? "bolt11" : "bolt11",
      note: input.includes("@") ? input : undefined,
    };
    this.payments.unshift(rec);
    this.changed();
    await new Promise((r) => setTimeout(r, 1200));
    rec.status = "settled";
    rec.settledAt = Date.now();
    this.spendableSat = Math.max(0, this.spendableSat - amt);
    this.receivableSat += amt;
    this.changed();
    return { preimage: fakeHash(), amountSats: amt };
  }

  async getChannels() {
    if (!this.running || this.channels === 0) return [];
    return [
      {
        channelId: "demo-channel",
        counterpartyNodeId: LSP_PUBKEY,
        capacitySat: CHANNEL_CAPACITY,
        outboundSendableSat: this.spendableSat,
        inboundSat: this.receivableSat,
        isUsable: true,
        isChannelReady: true,
        confirmations: 1,
        confirmationsRequired: 0,
      },
    ];
  }

  // The LSP order "just happens": no payment needed — paid after 4s, completed (channel
  // open) after 8s, mirroring the mock LSPS1 server's timed auto-walk.
  async purchaseLSPS1Capacity(params: { amountSats: number }) {
    if (!this.running) throw new Error("Wallet is not running");
    const orderId = `demo-${fakeHash().slice(0, 12)}`;
    this.orders.set(orderId, { createdAt: Date.now() });
    return {
      orderId,
      invoice: `${FAKE_INVOICE_PREFIX}fee${OPENING_FEE}${fakeHash().slice(0, 40)}`,
      feeTotalSat: String(OPENING_FEE),
    };
  }

  async getLSPS1Order(_apiUrl: string, orderId: string): Promise<unknown> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error("Unknown demo order");
    const age = Date.now() - order.createdAt;
    if (age > 8000) {
      if (this.channels === 0) {
        this.channels = 1;
        this.receivableSat = CHANNEL_CAPACITY - Math.ceil(CHANNEL_CAPACITY / 100);
        this.changed();
      }
      return { order_state: "COMPLETED", payment: { bolt11: { state: "PAID" } } };
    }
    if (age > 4000) return { order_state: "CREATED", payment: { bolt11: { state: "PAID" } } };
    return { order_state: "CREATED", payment: { bolt11: { state: "EXPECT_PAYMENT" } } };
  }

  async nwcCreateConnection(name: string, opts?: { spendingLimitSats?: number }): Promise<{ uri: string }> {
    if (this.connections.length >= 10) throw new Error("Connection limit reached (10).");
    this.connections.push({
      name: name || "Demo app",
      clientPubkey: fakeHash().slice(0, 64),
      relayUrl: "wss://relay.getalby.com/v1",
      spendingLimitSats: opts?.spendingLimitSats ?? 0,
      spentThisPeriodSats: 0,
      createdAt: Date.now(),
    });
    this.changed();
    return { uri: `nostr+walletconnect://${fakeHash()}?relay=wss%3A%2F%2Frelay.demo&secret=${fakeHash()}` };
  }

  async nwcListConnections(): Promise<NwcConnectionView[]> {
    return [...this.connections];
  }

  async nwcDeleteConnection(clientPubkey: string): Promise<void> {
    this.connections = this.connections.filter((c) => c.clientPubkey !== clientPubkey);
    this.changed();
  }

  async listPeers(): Promise<PeerRow[]> {
    return this.peers.map((p) => ({ ...p, hasChannel: p.pubkey === LSP_PUBKEY && this.channels > 0 }));
  }

  async connectPeer(pubkey: string, host: string, port: number): Promise<void> {
    this.peers.push({ pubkey, address: `${host}:${port}`, connected: true, hasChannel: false });
    this.changed();
  }

  async syncGossip(): Promise<void> {}

  async getConfig() {
    return { network: "demo", esploraUrl: "", bridgeUrl: "", rapidGossipSyncUrl: "", peer: "" };
  }

  async setConfig(): Promise<never> {
    throw new Error("Settings can't be changed in demo mode.");
  }

  async getSweepAddress(): Promise<{ address: string }> {
    return { address: this.sweepAddress };
  }

  async setSweepAddress(address: string): Promise<{ address: string }> {
    this.sweepAddress = (address || "").trim();
    return { address: this.sweepAddress };
  }

  walletPubkeyForPush(): string | null {
    return null;
  }

  buildGatewayAuth(): never {
    throw new Error("Push isn't available in demo mode.");
  }
}
