import {
  LibreListenerWallet,
  IndexedDBStorageProvider,
  bytesToHex,
  type SecureStorageProvider,
} from "@libre/listener-wallet";
import {
  dbNameForNetwork,
  META_DB_NAME,
  ACTIVE_NETWORK_KEY,
} from "../core/storage-namespace";
import { parseConfig, serializeConfig, CONFIG_KEY, type ExtensionConfig } from "../core/wallet-config";
import { createWebSocketStreamProvider } from "../core/ws-provider";
import { PaymentTracker } from "./payment-tracker";
import { payBolt11 } from "./pay-invoice";
import type { WalletRpc } from "../core/webln-mapping";

const KEYSEND_TIMEOUT_MS = 90_000;

// Keys the SDK / app persist that this host reasons about.
const CHANNEL_MANAGER_KEY = "channel_manager";
const SEED_KEY = "ldk_seed";
const CREATED_NEW_KEY = "wallet_created_new"; // provenance marker: this seed was created fresh here

export type HostEvent = (event: string, payload?: any) => void;

// Owns the single LDK node inside the offscreen document. Everything that opens the wallet's
// IndexedDB lives here — content scripts and pages never touch it. Exposes both the WebLN-facing
// WalletRpc and the trusted control-plane the popup/options drive.
export class WalletHost implements WalletRpc {
  private wallet?: LibreListenerWallet;
  private tracker?: PaymentTracker;
  private meta: SecureStorageProvider;
  private emit: HostEvent;

  constructor(emit: HostEvent = () => {}) {
    this.meta = new IndexedDBStorageProvider(META_DB_NAME);
    this.emit = emit;
  }

  private async activeNetwork(): Promise<string> {
    return (await this.meta.getItem(ACTIVE_NETWORK_KEY)) || "mainnet";
  }

  private storageForNetwork(network: string): SecureStorageProvider {
    return new IndexedDBStorageProvider(dbNameForNetwork(network));
  }

  async getConfig(): Promise<ExtensionConfig> {
    const network = await this.activeNetwork();
    const storage = this.storageForNetwork(network);
    const cfg = parseConfig(await storage.getItem(CONFIG_KEY));
    cfg.network = network as ExtensionConfig["network"];
    return cfg;
  }

  async setConfig(patch: Partial<ExtensionConfig>): Promise<ExtensionConfig> {
    if (this.wallet) throw new Error("Stop the node before changing configuration.");
    const network = patch.network || (await this.activeNetwork());
    const storage = this.storageForNetwork(network);
    const current = parseConfig(await storage.getItem(CONFIG_KEY));
    const next: ExtensionConfig = { ...current, ...patch, network: network as ExtensionConfig["network"] };
    await storage.setItem(CONFIG_KEY, serializeConfig(next));
    await this.meta.setItem(ACTIVE_NETWORK_KEY, network);
    return next;
  }

  // Snapshot for the popup/options UI.
  async getState(): Promise<{
    network: string;
    running: boolean;
    hasSeed: boolean;
    hasChannelState: boolean;
    createdNew: boolean;
    nodeId?: string;
    balance?: { spendableSat: number; receivableSat: number };
    channels?: number;
    peers?: number;
  }> {
    const network = await this.activeNetwork();
    const storage = this.storageForNetwork(network);
    const hasSeed = !!(await storage.getItem(SEED_KEY));
    const hasChannelState = !!(await storage.getItem(CHANNEL_MANAGER_KEY));
    const createdNew = !!(await storage.getItem(CREATED_NEW_KEY));
    const running = !!this.wallet && this.wallet.status() === "Running";
    let nodeId: string | undefined;
    let balance: { spendableSat: number; receivableSat: number } | undefined;
    let channels: number | undefined;
    let peers: number | undefined;
    if (running && this.wallet) {
      const mgr = this.wallet.getChannelManager();
      if (mgr) nodeId = bytesToHex(mgr.get_our_node_id());
      balance = this.wallet.getBalance();
      channels = this.wallet.getChannels().length;
      peers = this.wallet.getConnectedPeers().length;
    }
    return { network, running, hasSeed, hasChannelState, createdNew, nodeId, balance, channels, peers };
  }

  // Build (but do not start) the wallet instance for the active network.
  private async buildWallet(): Promise<LibreListenerWallet> {
    const cfg = await this.getConfig();
    const storage = this.storageForNetwork(cfg.network);
    const socketProvider = createWebSocketStreamProvider(() => cfg.bridgeUrl);
    const wallet = new LibreListenerWallet({
      config: {
        network: cfg.network,
        esploraUrl: cfg.esploraUrl,
        rapidGossipSyncUrl: cfg.rapidGossipSyncUrl,
        alias: "Libre Listener Wallet",
      } as any,
      storage,
      socketProvider,
      wasmUrl: chrome.runtime.getURL("liblightningjs.wasm"),
      logger: {
        info: (m, ...a) => console.log("[LDK]", m, ...a),
        warn: (m, ...a) => console.warn("[LDK]", m, ...a),
        error: (m, ...a) => console.error("[LDK]", m, ...a),
      },
    });
    // Clear the brand-new provenance marker once real channel state exists (mirrors the app's
    // wallet-readiness guard) and push live updates to the UI.
    wallet.onStateChanged(() => {
      void (async () => {
        if (await storage.getItem(CHANNEL_MANAGER_KEY)) {
          await storage.removeItem(CREATED_NEW_KEY);
        }
        this.emit("state-changed");
      })();
    });
    return wallet;
  }

  // Start the node, enforcing the readiness guard: a seed with no channel state may start ONLY
  // if it was created brand-new here. A stateless restored/injected seed that auto-starts would
  // bootstrap an empty ChannelManager, connect the peer, and force-close the real channel on
  // channel_reestablish — the exact mainnet failure documented in the SDK gotchas.
  async startNode(): Promise<{ nodeId: string; network: string }> {
    if (this.wallet && this.wallet.status() === "Running") {
      return this.currentNode();
    }
    const network = await this.activeNetwork();
    const storage = this.storageForNetwork(network);
    const hasSeed = !!(await storage.getItem(SEED_KEY));
    const hasChannelState = !!(await storage.getItem(CHANNEL_MANAGER_KEY));
    const createdNew = !!(await storage.getItem(CREATED_NEW_KEY));
    if (!hasSeed && !createdNew) {
      throw new Error("No wallet on this network. Create a new wallet or restore from a backup first.");
    }
    if (hasSeed && !hasChannelState && !createdNew) {
      throw new Error(
        "This seed has no channel state. Restore from a backup before starting — starting a stateless node can force-close existing channels."
      );
    }
    this.wallet = await this.buildWallet();
    this.tracker = new PaymentTracker(this.wallet);
    await this.wallet.start();
    // Warm the routing graph best-effort (mainnet only serves RGS snapshots).
    void this.wallet.syncGossip().catch(() => {});
    this.emit("state-changed");
    return this.currentNode();
  }

  async stopNode(): Promise<void> {
    if (this.wallet) {
      await this.wallet.stop();
      this.wallet = undefined;
      this.tracker = undefined;
      this.emit("state-changed");
    }
  }

  // Create a fresh wallet: generate (or accept) a 32-byte seed, mark it brand-new, persist, and
  // start. Refuses to clobber a wallet that already has channel state (funds-protection).
  async createWallet(opts?: { seedHex?: string }): Promise<{ seedHex: string; nodeId: string; network: string }> {
    const network = await this.activeNetwork();
    const storage = this.storageForNetwork(network);
    if (await storage.getItem(CHANNEL_MANAGER_KEY)) {
      throw new Error("A funded wallet already exists on this network. Refusing to overwrite it.");
    }
    const seedHex = opts?.seedHex ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error("Seed must be 64 hex characters (32 bytes).");
    await storage.setItem(SEED_KEY, seedHex.toLowerCase());
    await storage.setItem(CREATED_NEW_KEY, "1");
    const node = await this.startNode();
    return { seedHex: seedHex.toLowerCase(), ...node };
  }

  // Restore from an encrypted backup envelope. importState writes seed + channel state + network
  // (and enforces the network match), so the readiness guard is satisfied afterwards.
  async restoreWallet(envelope: string, secret: string): Promise<{ nodeId: string; network: string }> {
    // Peek the backup's network so we open/point at the right DB before importing.
    const probe = await this.buildWallet();
    const verified = await probe.verifyBackup(envelope, secret);
    if (!verified.ok) throw new Error("Backup could not be decrypted with that secret.");
    if (verified.network) {
      await this.meta.setItem(ACTIVE_NETWORK_KEY, verified.network);
    }
    // Rebuild against the (now correct) network DB and import.
    const wallet = await this.buildWallet();
    await wallet.importState(envelope, secret);
    this.wallet = wallet;
    this.tracker = new PaymentTracker(wallet);
    await wallet.start();
    void wallet.syncGossip().catch(() => {});
    this.emit("state-changed");
    return this.currentNode();
  }

  async exportBackup(): Promise<string> {
    this.requireRunning();
    return this.wallet!.exportState();
  }

  async connectPeer(pubkey: string, host: string, port: number): Promise<void> {
    this.requireRunning();
    await this.wallet!.connectPeer(pubkey, host, port);
    this.emit("state-changed");
  }

  async syncGossip(): Promise<void> {
    this.requireRunning();
    await this.wallet!.syncGossip();
  }

  // ---- WalletRpc (WebLN-facing) ----

  async getInfo(): Promise<{ pubkey: string; alias: string; network: string }> {
    this.requireRunning();
    const mgr = this.wallet!.getChannelManager();
    if (!mgr) throw new Error("Wallet not started");
    return {
      pubkey: bytesToHex(mgr.get_our_node_id()),
      alias: "Libre Listener Wallet",
      network: await this.activeNetwork(),
    };
  }

  async getBalanceSats(): Promise<number> {
    this.requireRunning();
    return this.wallet!.getBalance().spendableSat;
  }

  async makeInvoice(args: { amountSats: number; memo: string; expirySeconds: number }): Promise<{ paymentRequest: string }> {
    this.requireRunning();
    const paymentRequest = await this.wallet!.createInvoice(args.amountSats, args.memo || "Libre Listener Wallet", args.expirySeconds);
    return { paymentRequest };
  }

  async payInvoice(bolt11: string): Promise<{ preimage: string }> {
    this.requireRunning();
    const { preimage } = await payBolt11(this.wallet!, this.tracker!, bolt11);
    return { preimage };
  }

  async keysend(args: {
    destination: string;
    amountSats: number;
    customRecords: Record<number, string>;
  }): Promise<{ preimage: string }> {
    this.requireRunning();
    // Generate the preimage so we can register the settlement waiter before initiating — no race
    // with Event_PaymentSent (same approach as NwcManager.pay_keysend).
    const preimage = crypto.getRandomValues(new Uint8Array(32));
    const hashHex = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", preimage as unknown as ArrayBuffer)));
    const settled = this.tracker!.waitForSettlement(hashHex, KEYSEND_TIMEOUT_MS);
    const res = await this.wallet!.sendKeysendPayment({
      destinationPubkey: args.destination,
      amountSats: args.amountSats,
      customRecords: args.customRecords,
      preimage,
    });
    if (!res.ok) throw new Error(`Keysend failed to initiate: ${res.error}`);
    const preimageHex = await settled;
    return { preimage: preimageHex };
  }

  private currentNode(): { nodeId: string; network: string } {
    this.requireRunning();
    const mgr = this.wallet!.getChannelManager();
    return { nodeId: mgr ? bytesToHex(mgr.get_our_node_id()) : "", network: (this.wallet as any).config?.network ?? "" };
  }

  private requireRunning(): void {
    if (!this.wallet || this.wallet.status() !== "Running") throw new Error("Wallet is not running");
  }
}
