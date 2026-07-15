import {
  LibreListenerWallet,
  IndexedDBStorageProvider,
  bytesToHex,
  seedHexToMnemonic,
  type SecureStorageProvider,
  type ChannelInfo,
  type PaymentRecord,
} from "@libre/listener-wallet";
import {
  zeroConfTrustedPubkeys,
  acquireWebNodeLock,
  nodeLockName,
  autoStartPlan,
  connectWithRetry,
  shouldReconnectPeer,
  resolveInvoiceExpiry,
} from "@libre/shared";
import type { BudgetRenewal, NwcMethod } from "@libre/shared";
import {
  dbNameForNetwork,
  META_DB_NAME,
  ACTIVE_NETWORK_KEY,
} from "../core/storage-namespace";
import {
  parseConfig,
  serializeConfig,
  defaultEsploraUrl,
  defaultBridgeUrl,
  defaultRapidGossipSyncUrl,
  defaultPeer,
  parsePeerString,
  formatPeerString,
  CONFIG_KEY,
  type ExtensionConfig,
} from "../core/wallet-config";
import { createWebSocketStreamProvider } from "../core/ws-provider";
import { PaymentTracker } from "./payment-tracker";
import { payBolt11 } from "./pay-invoice";
import { restoreBlockReason } from "./restore-guard";
import { downloadBackupName } from "../core/backup-name";
import { addressToScriptPubKey } from "../core/address-script";
import type { WalletRpc } from "../core/webln-mapping";

const KEYSEND_TIMEOUT_MS = 90_000;

// Keys the SDK / app persist that this host reasons about.
const CHANNEL_MANAGER_KEY = "channel_manager";
const SEED_KEY = "ldk_seed";
const CREATED_NEW_KEY = "wallet_created_new"; // provenance marker: this seed was created fresh here
const SWEEP_ADDRESS_KEY = "libre_sweep_address"; // on-chain address to recover force-closed funds

export type HostEvent = (event: string, payload?: any) => void;

// Owns the single LDK node inside the offscreen document. Everything that opens the wallet's
// IndexedDB lives here — content scripts and pages never touch it. Exposes both the WebLN-facing
// WalletRpc and the trusted control-plane the popup/options drive.
export class WalletHost implements WalletRpc {
  private wallet?: LibreListenerWallet;
  private tracker?: PaymentTracker;
  private meta: SecureStorageProvider;
  private emit: HostEvent;
  private restoring = false; // serializes restoreWallet against a concurrent (double-click) call

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
    usableChannels?: number;
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
    let usableChannels: number | undefined;
    let peers: number | undefined;
    if (running && this.wallet) {
      const mgr = this.wallet.getChannelManager();
      if (mgr) nodeId = bytesToHex(mgr.get_our_node_id());
      balance = this.wallet.getBalance();
      const chans = this.wallet.getChannels();
      channels = chans.length;
      usableChannels = chans.filter((c) => c.isUsable).length;
      peers = this.wallet.getConnectedPeers().length;
    }
    return { network, running, hasSeed, hasChannelState, createdNew, nodeId, balance, channels, usableChannels, peers };
  }

  // Build (but do not start) the wallet instance for the active network.
  private async buildWallet(): Promise<LibreListenerWallet> {
    const cfg = await this.getConfig();
    const storage = this.storageForNetwork(cfg.network);
    // Fall back to the network's public defaults so an unconfigured wallet still reaches its
    // bridge/esplora/RGS (mainnet ships the same infra as the PWA); user config always wins.
    const bridgeUrl = cfg.bridgeUrl || defaultBridgeUrl(cfg.network);
    const socketProvider = createWebSocketStreamProvider(() => bridgeUrl);
    const wallet = new LibreListenerWallet({
      config: {
        network: cfg.network,
        // Always a defined string — falls back to a public per-network endpoint so start() never
        // crashes the SDK's EsploraSyncClient on an unconfigured wallet.
        esploraUrl: cfg.esploraUrl || defaultEsploraUrl(cfg.network),
        rapidGossipSyncUrl: cfg.rapidGossipSyncUrl || defaultRapidGossipSyncUrl(cfg.network),
        alias: "Libre Listener Wallet",
        // Allowlist genuinely-0-conf LSPs (Megalith) so their channels are instant. The SDK only
        // 0-conf-accepts a zeroconf-typed open, so a confirmed open still falls back safely.
        trustedZeroConfPeers: zeroConfTrustedPubkeys(),
      } as any,
      storage,
      socketProvider,
      wasmUrl: chrome.runtime.getURL("liblightningjs.wasm"),
      // Per-origin single-node lock: only one context (offscreen document) may run this network's
      // node at a time — guards against a stray second offscreen document racing the same storage.
      acquireRunLock: () => acquireWebNodeLock(nodeLockName(dbNameForNetwork(cfg.network))),
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

  // Serialize concurrent start calls (autoStart racing a popup Start click must not build two
  // wallets over the same storage).
  private startingPromise?: Promise<{ nodeId: string; network: string }>;

  async startNode(): Promise<{ nodeId: string; network: string }> {
    if (this.startingPromise) return this.startingPromise;
    if (this.wallet && this.wallet.status() === "Running") {
      return this.currentNode();
    }
    this.startingPromise = this.doStartNode().finally(() => {
      this.startingPromise = undefined;
    });
    return this.startingPromise;
  }

  private async doStartNode(): Promise<{ nodeId: string; network: string }> {
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
    const wallet = await this.buildWallet();
    this.wallet = wallet;
    this.tracker = new PaymentTracker(wallet);
    try {
      // start() already brings NWC up (nwc.init()+start()) — do NOT init it again here, or a second
      // LDK event listener gets registered and every payment event is processed twice.
      await wallet.start();
    } catch (e) {
      // Don't leave a half-built wallet assigned — otherwise setConfig ("stop the node first")
      // stays blocked and the user can't fix a bad config after a failed start.
      this.wallet = undefined;
      this.tracker = undefined;
      throw e;
    }
    await this.applySweepAddress();
    // Warm the routing graph best-effort (mainnet only serves RGS snapshots).
    void wallet.syncGossip().catch((e) => console.warn("[Gossip] initial sync failed:", e?.message || e));
    this.emit("state-changed");
    return this.currentNode();
  }

  // Boot-time auto-start: invoked (via the autoStart RPC) by the background right after it
  // creates this offscreen document. NEVER throws — a failed or skipped auto-start leaves the
  // host stopped and the popup's manual Start working. `flagRaw` is the raw auto_start value
  // read by the BACKGROUND: offscreen documents only get chrome.runtime, chrome.storage is
  // literally undefined here (reading it in this context killed auto-start on every launch —
  // pinned by runtime-only-apis.test.ts). The plan mirrors the PWA's assessStartReadiness: a
  // stateless non-created-here seed is a silent skip here AND still a hard error in startNode()
  // (two layers against the empty-node-force-closes-the-channel failure).
  async autoStart(flagRaw: string | null): Promise<void> {
    try {
      const network = await this.activeNetwork();
      const storage = this.storageForNetwork(network);
      const plan = autoStartPlan({
        flagRaw,
        hasSeed: !!(await storage.getItem(SEED_KEY)),
        hasChannelState: !!(await storage.getItem(CHANNEL_MANAGER_KEY)),
        createdNew: !!(await storage.getItem(CREATED_NEW_KEY)),
      });
      if (!plan.start) {
        console.log(`[AutoStart] skipped: ${plan.reason}`);
        return;
      }
      await this.startNode();
      if (!plan.connectPeer) return;
      // Empty/lost-state guard (the 2026-07-13 mainnet force-close): NEVER auto-dial a peer from a
      // wallet that holds no channels. plan.connectPeer keys on hasChannelState = "channel_manager
      // blob present", which is TRUE even for an empty manager (0 channels/monitors) — so an
      // incomplete restore, evicted storage, or the same seed running elsewhere would otherwise
      // connect, and LDK (no record of the channel the peer still holds) sends a channel-closure
      // ChannelReestablish → force-close. The live channel count is the ground truth.
      if (!this.wallet || !shouldReconnectPeer(this.wallet.getChannels().length)) {
        console.warn("[AutoStart] wallet holds no channels — skipping auto peer connect (empty/lost-state guard)");
        return;
      }

      const cfg = await this.getConfig();
      const savedPeer = cfg.peer;
      const peerStr = savedPeer || defaultPeer(network);
      if (!peerStr) {
        console.warn("[AutoStart] no saved or default peer for this network — skipping peer connect");
        return;
      }
      if (!savedPeer) {
        // A wallet funded before peer persistence existed has no saved peer. The network default
        // may not be its channel peer — connect the real peer once (popup → Connect peer) to save it.
        console.warn("[AutoStart] no saved peer — dialing the network default, which may not be your channel peer");
      }
      const { pubkey, host, port } = parsePeerString(peerStr);
      const wallet = this.wallet; // abort the retry loop if stop()/restore swaps the instance
      const connected = await connectWithRetry(
        async () => {
          await wallet!.connectPeer(pubkey, host, port);
        },
        {
          shouldContinue: () => this.wallet === wallet && !!wallet && wallet.status() === "Running",
          onAttemptFailed: (n, e) =>
            console.warn(`[AutoStart] peer connect attempt ${n} failed:`, (e as Error)?.message || e),
        }
      );
      if (connected) {
        this.emit("state-changed");
        console.log(`[AutoStart] node running, ${savedPeer ? "saved peer" : "default peer"} connected`);
      } else {
        console.warn("[AutoStart] peer connect gave up — use Connect peer in the popup");
      }
    } catch (e) {
      console.warn("[AutoStart] failed:", (e as Error)?.message || e);
    }
  }

  // Wipe the wallet for the active network: stop the node, then erase its IndexedDB (seed +
  // channel state + monitors). DESTRUCTIVE — any funds in a live channel are lost; the UI gates
  // this behind an explicit confirmation. Leaves the network pointer + saved config intact.
  async resetWallet(): Promise<{ network: string }> {
    // Settle an in-flight start first (auto-start makes one the default state at boot) — tearing
    // down a wallet still inside start() orphans live timers and lets a later Start double-build
    // over the same IndexedDB.
    if (this.startingPromise) await this.startingPromise.catch(() => {});
    const network = await this.activeNetwork();
    if (this.wallet) {
      await this.wallet.nwc.stop().catch((e) => console.warn("[NWC] stop failed:", e?.message || e));
      await this.wallet.stop();
      this.wallet = undefined;
      this.tracker = undefined;
    }
    await new IndexedDBStorageProvider(dbNameForNetwork(network)).clear();
    this.emit("state-changed");
    return { network };
  }

  async stopNode(): Promise<void> {
    // Settle an in-flight start first (auto-start makes one the default state at boot) — tearing
    // down a wallet still inside start() orphans live timers and lets a later Start double-build
    // over the same IndexedDB.
    if (this.startingPromise) await this.startingPromise.catch(() => {});
    if (this.wallet) {
      await this.wallet.nwc.stop().catch((e) => console.warn("[NWC] stop failed:", e?.message || e));
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

  // Return the active network's seed as its 24-word BIP39 recovery phrase, for on-device display
  // in the options UI (control-plane only — never a WebLN/page-reachable method, never logged).
  // Reads storage directly, so it works whether or not the node is running.
  async getRecoveryPhrase(): Promise<{ mnemonic: string }> {
    return { mnemonic: seedHexToMnemonic(await this.readSeedHex()) };
  }

  // Return the active network's raw 64-hex seed (this app's native format — the simplest thing to
  // paste back into the Seed field). Same control-plane/never-logged rules as getRecoveryPhrase.
  async getSeed(): Promise<{ seedHex: string }> {
    return { seedHex: await this.readSeedHex() };
  }

  // Read + validate the active network's stored seed. Throws if there's no wallet yet.
  private async readSeedHex(): Promise<string> {
    const storage = this.storageForNetwork(await this.activeNetwork());
    const seedHex = await storage.getItem(SEED_KEY);
    if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
      throw new Error("No wallet seed on this network — create or restore a wallet first.");
    }
    return seedHex;
  }

  // Restore from an encrypted backup envelope. importState writes seed + channel state + network
  // (and enforces the network match), so the readiness guard is satisfied afterwards.
  async restoreWallet(envelope: string, secret: string): Promise<{ nodeId: string; network: string }> {
    // Refuse to restore under a running node or a concurrent restore (see restore-guard).
    const early = restoreBlockReason({ running: !!this.wallet, restoring: this.restoring, targetHasChannelState: false });
    if (early) throw new Error(early);
    this.restoring = true;
    try {
      // Peek the backup's network so we open/point at the right DB before importing.
      const probe = await this.buildWallet();
      const verified = await probe.verifyBackup(envelope, secret);
      if (!verified.ok) throw new Error("Backup could not be decrypted with that secret.");
      // Refuse to overwrite an existing funded wallet on the target network — check BEFORE moving
      // the active-network pointer, so a refused restore leaves no side effects.
      const targetNetwork = verified.network || (await this.activeNetwork());
      const targetStorage = this.storageForNetwork(targetNetwork);
      const funded = restoreBlockReason({
        running: false,
        restoring: false,
        targetHasChannelState: !!(await targetStorage.getItem(CHANNEL_MANAGER_KEY)),
      });
      if (funded) throw new Error(funded);
      if (verified.network) {
        await this.meta.setItem(ACTIVE_NETWORK_KEY, verified.network);
      }
      // Rebuild against the (now correct) network DB and import.
      const wallet = await this.buildWallet();
      await wallet.importState(envelope, secret);
      this.wallet = wallet;
      this.tracker = new PaymentTracker(wallet);
      // start() brings NWC up; no separate init (avoids a duplicate LDK event listener).
      await wallet.start();
      await this.applySweepAddress();
      void wallet.syncGossip().catch((e) => console.warn("[Gossip] initial sync failed:", e?.message || e));
      this.emit("state-changed");
      return this.currentNode();
    } finally {
      this.restoring = false;
    }
  }

  async exportBackup(): Promise<string> {
    this.requireRunning();
    return this.wallet!.exportState();
  }

  // ---- Force-close recovery: on-chain sweep address ----

  async getSweepAddress(): Promise<{ address: string }> {
    const storage = this.storageForNetwork(await this.activeNetwork());
    return { address: (await storage.getItem(SWEEP_ADDRESS_KEY)) || "" };
  }

  // Persist the on-chain address force-closed funds sweep to, and push it to the running node so a
  // close event (Event_SpendableOutputs) can recover funds. Validates by decoding — a bad address
  // throws before anything is saved. An empty string clears it.
  async setSweepAddress(address: string): Promise<{ address: string }> {
    const addr = (address || "").trim();
    if (addr) addressToScriptPubKey(addr); // throws on an invalid address
    const storage = this.storageForNetwork(await this.activeNetwork());
    if (addr) await storage.setItem(SWEEP_ADDRESS_KEY, addr);
    else await storage.removeItem(SWEEP_ADDRESS_KEY);
    if (this.wallet) this.wallet.setSweepDestination(addr ? addressToScriptPubKey(addr) : undefined);
    return { address: addr };
  }

  // Push the persisted sweep address into the node (called on start). Best-effort: a bad/missing
  // address just means no auto-sweep until the user sets a valid one.
  private async applySweepAddress(): Promise<void> {
    try {
      const storage = this.storageForNetwork(await this.activeNetwork());
      const addr = (await storage.getItem(SWEEP_ADDRESS_KEY))?.trim();
      if (addr && this.wallet) this.wallet.setSweepDestination(addressToScriptPubKey(addr));
    } catch (e) {
      console.warn("[Sweep] could not apply saved sweep address:", (e as Error)?.message || e);
    }
  }

  // Export the backup as a Blob URL the background can hand to chrome.downloads (a service worker
  // can't create Blob URLs; the offscreen document can). The URL is revoked after a grace period so
  // the download has time to read it. Uses a FIXED per-network filename so the auto-backup overwrites
  // one rolling file instead of piling up dated copies (the manual button keeps dated snapshots).
  async exportBackupBlob(): Promise<{ url: string; filename: string }> {
    this.requireRunning();
    const envelope = await this.wallet!.exportState();
    const network = await this.activeNetwork();
    const filename = `libre-wallet-backup-${network}-auto.json`;
    const url = URL.createObjectURL(new Blob([envelope], { type: "application/json" }));
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    return { url, filename };
  }

  // Top up: a BOLT11 invoice to receive into existing inbound capacity (open a channel first).
  async createInvoice(amountSats: number, memo?: string, expirySeconds?: number): Promise<{ paymentRequest: string }> {
    this.requireRunning();
    const amt = Math.floor(Number(amountSats));
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter an amount in sats greater than 0.");
    const paymentRequest = await this.wallet!.createInvoice(amt, memo || "Libre Listener Wallet top-up", resolveInvoiceExpiry(expirySeconds));
    return { paymentRequest };
  }

  // ---- NWC (Nostr Wallet Connect) pairings ----

  async nwcCreateConnection(
    name: string,
    opts?: {
      spendingLimitSats?: number;
      relayUrl?: string;
      budgetRenewal?: BudgetRenewal;
      maxAmountSats?: number;
      allowedMethods?: NwcMethod[];
      expiresAt?: number;
    }
  ): Promise<{ uri: string }> {
    this.requireRunning();
    const uri = await this.wallet!.nwc.createConnection(name || "Nostr Client App", {
      spendingLimitSats: Number(opts?.spendingLimitSats) || 0,
      relayUrl: opts?.relayUrl,
      budgetRenewal: opts?.budgetRenewal,
      maxAmountSats: opts?.maxAmountSats,
      allowedMethods: opts?.allowedMethods,
      expiresAt: opts?.expiresAt,
    });
    this.emit("state-changed");
    return { uri };
  }

  async nwcListConnections(): Promise<Array<{ name: string; clientPubkey: string; relayUrl: string; spendingLimitSats: number; spentTodaySats?: number }>> {
    this.requireRunning();
    const list = await this.wallet!.nwc.listConnections();
    // Deliberately omit each pairing's `secret` — it never leaves the offscreen host.
    return list.map((c) => ({
      name: c.name,
      clientPubkey: c.clientPubkey,
      relayUrl: c.relayUrl,
      spendingLimitSats: c.spendingLimitSats ?? 0,
      spentTodaySats: c.spentTodaySats ?? 0,
    }));
  }

  async nwcDeleteConnection(clientPubkey: string): Promise<void> {
    this.requireRunning();
    await this.wallet!.nwc.deleteConnection(clientPubkey);
    this.emit("state-changed");
  }

  async connectPeer(pubkey: string, host: string, port: number): Promise<void> {
    this.requireRunning();
    await this.wallet!.connectPeer(pubkey, host, port);
    await this.savePeer(pubkey, host, port);
    this.emit("state-changed");
  }

  // Remember the last successfully connected peer so auto-start can redial it. Written directly
  // to the network's config JSON (setConfig refuses while the node runs — this is an internal,
  // non-destructive single-field update). Best-effort: a persist failure must not fail the
  // connect that already succeeded.
  private async savePeer(pubkey: string, host: string, port: number): Promise<void> {
    try {
      const network = await this.activeNetwork();
      const storage = this.storageForNetwork(network);
      const cfg = parseConfig(await storage.getItem(CONFIG_KEY));
      cfg.network = network as ExtensionConfig["network"];
      cfg.peer = formatPeerString(pubkey, host, port);
      await storage.setItem(CONFIG_KEY, serializeConfig(cfg));
    } catch (e) {
      console.warn("[Peer] could not persist last-connected peer:", (e as Error)?.message || e);
    }
  }

  async syncGossip(): Promise<void> {
    this.requireRunning();
    await this.wallet!.syncGossip();
  }

  // Buy inbound liquidity from a real mainnet LSP over the LSPS1 REST binding (Megalith / Olympus).
  // Returns the payment invoice + real opening fee; pay it, then poll getLSPS1Order until COMPLETED.
  // The api_url is the provider's REST base; the peer node is read live from its get_info uris.
  async purchaseLSPS1Capacity(params: {
    amountSats: number;
    apiUrl: string;
    providerName: string;
    channelExpiryBlocks?: number;
  }): Promise<{ orderId: string; invoice: string; feeTotalSat?: string; onchainAddress?: string; lspPeerUri?: string }> {
    this.requireRunning();
    return this.wallet!.purchaseLSPS1Capacity({
      amountSats: params.amountSats,
      lsp: {
        name: params.providerName,
        pubkey: "",
        connection_string: "",
        api_url: params.apiUrl,
        protocols: ["lsps1"],
      },
      ...(params.channelExpiryBlocks != null ? { channelExpiryBlocks: params.channelExpiryBlocks } : {}),
    });
  }

  // Poll an LSPS1 order's status after paying its invoice (COMPLETED once the channel opens).
  async getLSPS1Order(apiUrl: string, orderId: string): Promise<unknown> {
    this.requireRunning();
    return this.wallet!.getLSPS1Order(apiUrl, orderId);
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

  async getChannels(): Promise<ChannelInfo[]> {
    this.requireRunning();
    return this.wallet!.getChannels();
  }

  // Forward-only payment history for the options-page "Transaction history" card. Node
  // must be running (matches the channels card gating). Control-plane only — never a
  // WebLN/page-reachable method.
  async getPayments(): Promise<PaymentRecord[]> {
    this.requireRunning();
    return this.wallet!.getPayments();
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
    if (!res.ok) {
      // Nothing was sent, so the settlement waiter can never resolve — detach it so its
      // timeout doesn't surface as an uncaught rejection ~90s after every failed split.
      void settled.catch(() => {});
      throw new Error(`Keysend failed to initiate: ${res.error}`);
    }
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
