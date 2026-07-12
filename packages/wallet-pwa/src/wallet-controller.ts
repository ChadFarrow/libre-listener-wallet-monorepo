import {
  LibreListenerWallet,
  IndexedDBStorageProvider,
  PaymentLogger,
  CloseLogger,
  SWEEP_LAST_KEY,
  bytesToHex,
  seedHexToMnemonic,
  resolveLnAddressInvoice,
  parsePeerAddressBook,
  type SecureStorageProvider,
  type ChannelInfo,
  type ChannelCloseRecord,
} from "@libre/listener-wallet";
import { zeroConfTrustedPubkeys, acquireWebNodeLock, nodeLockName, isNodeAlreadyRunningError } from "@libre/shared";
import { nodeLockRetryPlan } from "./core/start-retry";
import type { BudgetRenewal, NwcMethod, PaymentRecord } from "@libre/shared";
import { classifySendInput } from "./core/send-input";
import { sanitizeConnection, type NwcConnectionView } from "./core/nwc-connection-view";
import { buildPeerRows, type PeerRow } from "./core/peer-list";
import {
  dbNameForNetwork,
  META_DB_NAME,
  ACTIVE_NETWORK_KEY,
  SUPPORTED_NETWORKS,
} from "./core/storage-namespace";
import {
  parseConfig,
  serializeConfig,
  defaultEsploraUrl,
  defaultBridgeUrl,
  defaultRapidGossipSyncUrl,
  defaultPeer,
  parsePeerString,
  formatPeerString,
  resolveNodeAlias,
  CONFIG_KEY,
  NODE_ALIAS_KEY,
  type AppConfig,
} from "./core/wallet-config";
import { resolveActiveNetwork } from "./core/sw-config";
import { autoStartPlan, connectWithRetry } from "./core/auto-start";
import { createWebSocketStreamProvider } from "./core/ws-provider";
import { restoreBlockReason } from "./core/restore-guard";
import { addressToScriptPubKey } from "./core/address-script";
import { smoothUsable, type UsableSmootherState } from "./core/usable-smoothing";

// Keys the SDK / app persist that this controller reasons about.
const CHANNEL_MANAGER_KEY = "channel_manager";
const SEED_KEY = "ldk_seed";
const CREATED_NEW_KEY = "wallet_created_new"; // provenance marker: this seed was created fresh here
const SWEEP_ADDRESS_KEY = "libre_sweep_address"; // on-chain address to recover force-closed funds

export type ControllerEvent = (event: string, payload?: unknown) => void;

// Owns the single LDK node inside the PWA page. In the extension this same logic lived in the
// offscreen document and was reached over chrome.runtime RPC; here it is called directly by the
// home/settings views (no RPC, no chrome.*). WebLN is deliberately absent — the PWA cannot inject
// into other sites, so NWC is the only app-connectivity surface.
export class WalletController {
  private wallet?: LibreListenerWallet;
  private meta: SecureStorageProvider;
  private emit: ControllerEvent;
  private restoring = false; // serializes restoreWallet against a concurrent (double-click) call

  constructor(emit: ControllerEvent = () => {}) {
    this.meta = new IndexedDBStorageProvider(META_DB_NAME);
    this.emit = emit;
  }

  isRunning(): boolean {
    return !!this.wallet && this.wallet.status() === "Running";
  }

  // The NWC wallet-service pubkey the push gateway registers a subscription against.
  walletPubkeyForPush(): string | null {
    if (!this.wallet) return null;
    try {
      return this.wallet.nwc.getWalletPubkey() ?? null;
    } catch {
      return null;
    }
  }

  /** Sign a gateway push-auth (proof of control of the wallet's Nostr pubkey). Throws if not running. */
  buildGatewayAuth(action: "register" | "unregister", relayUrl: string, endpoint?: string) {
    this.requireRunning();
    return this.wallet!.nwc.buildGatewayAuth(action, relayUrl, endpoint);
  }

  private async activeNetwork(): Promise<string> {
    // Same default rule the service worker uses (core/sw-config.ts) — one definition.
    return resolveActiveNetwork(await this.meta.getItem(ACTIVE_NETWORK_KEY));
  }

  private storageForNetwork(network: string): SecureStorageProvider {
    return new IndexedDBStorageProvider(dbNameForNetwork(network));
  }

  // Persist the meta active-network pointer for the offline-push service worker (it has no DOM
  // and reads only what's on disk). ONLY the pointer is persisted: the SW layers the network's
  // public defaults over ldk_config itself at read time (core/sw-config.ts resolvePushConfig),
  // and materializing resolved defaults INTO stored user config would pin the install to today's
  // endpoints — a future change to the default esplora/bridge/RGS URL would never reach it.
  // Best-effort: a persist failure must never fail a start that already succeeded.
  private async persistActiveNetwork(network: string): Promise<void> {
    try {
      await this.meta.setItem(ACTIVE_NETWORK_KEY, network);
    } catch (e) {
      console.warn("[Config] could not persist the active network for the service worker:", (e as Error)?.message || e);
    }
  }

  async getConfig(): Promise<AppConfig> {
    const network = await this.activeNetwork();
    const storage = this.storageForNetwork(network);
    const cfg = parseConfig(await storage.getItem(CONFIG_KEY));
    cfg.network = network as AppConfig["network"];
    cfg.nodeAlias = await this.resolveAndMigrateAlias(storage, cfg.nodeAlias);
    return cfg;
  }

  // The node alias lives in its own `node_alias` storage key (NOT device-specific ldk_config) so
  // it's carried by the encrypted backup and syncs across devices. Prefer that key; for a pre-sync
  // install whose alias still sits inside ldk_config, migrate it to the dedicated key on first read
  // so exportState starts including it. Best-effort — a read must never fail on a migration write.
  private async resolveAndMigrateAlias(storage: SecureStorageProvider, legacy: string | undefined): Promise<string | undefined> {
    const dedicated = await storage.getItem(NODE_ALIAS_KEY);
    const alias = resolveNodeAlias(dedicated, legacy);
    if (alias && dedicated == null) {
      await storage.setItem(NODE_ALIAS_KEY, alias).catch((e) => {
        console.warn("[Config] could not migrate node alias to its backed-up key:", (e as Error)?.message || e);
      });
    }
    return alias;
  }

  async setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    if (this.wallet) throw new Error("Stop the node before changing configuration.");
    const network = patch.network || (await this.activeNetwork());
    const storage = this.storageForNetwork(network);
    const current = parseConfig(await storage.getItem(CONFIG_KEY));
    const next: AppConfig = { ...current, ...patch, network: network as AppConfig["network"] };
    await storage.setItem(CONFIG_KEY, serializeConfig(next));
    await this.meta.setItem(ACTIVE_NETWORK_KEY, network);
    return next;
  }

  // Save the node name without the stop-the-node guard: unlike endpoints/network it can't
  // affect the running node — the alias is read once at start(), so it just applies next start.
  async setNodeAlias(alias: string | undefined): Promise<void> {
    const network = await this.activeNetwork();
    const storage = this.storageForNetwork(network);
    const trimmed = alias?.trim();
    // The alias is authoritative in its own backed-up `node_alias` key (synced across devices).
    if (trimmed) await storage.setItem(NODE_ALIAS_KEY, trimmed);
    else await storage.removeItem(NODE_ALIAS_KEY);
    // Strip any legacy copy from device-specific ldk_config so it can never shadow the dedicated
    // key (e.g. reappear after the user clears the name). Only rewrite when it was actually there.
    const current = parseConfig(await storage.getItem(CONFIG_KEY));
    if (current.nodeAlias !== undefined) {
      delete current.nodeAlias;
      await storage.setItem(CONFIG_KEY, serializeConfig({ ...current, network: network as AppConfig["network"] }));
    }
  }

  // Snapshot for the home/settings views.
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
    startError?: string;
    closes: { count: number; last?: ChannelCloseRecord };
    sweep: { needsAddress: boolean; pendingCount: number; pendingSat: number; lastSweep?: { txid: string; sat: number; at: number } };
  }> {
    const network = await this.activeNetwork();
    const storage = this.storageForNetwork(network);
    const hasSeed = !!(await storage.getItem(SEED_KEY));
    const hasChannelState = !!(await storage.getItem(CHANNEL_MANAGER_KEY));
    const createdNew = !!(await storage.getItem(CREATED_NEW_KEY));
    const running = this.isRunning();
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
      // Smooth transient is_usable dips (monitor persist in flight, socket blip) so a healthy
      // wallet doesn't flash "0/1" in the drawer / "channel opening" on the home pill.
      const rawUsable = chans.filter((c) => c.isUsable).length;
      const smoothed = smoothUsable(this.usableView, rawUsable, channels, Date.now());
      this.usableView = smoothed.state;
      usableChannels = smoothed.shown;
      peers = this.wallet.getConnectedPeers().length;
    } else {
      this.usableView = undefined; // stopped: next start smooths from a fresh reading
    }
    const closeRecs = await this.getChannelCloses().catch(() => [] as ChannelCloseRecord[]);
    const closes = { count: closeRecs.length, ...(closeRecs[0] ? { last: closeRecs[0] } : {}) };
    let sweep: { needsAddress: boolean; pendingCount: number; pendingSat: number; lastSweep?: { txid: string; sat: number; at: number } } = {
      needsAddress: false,
      pendingCount: 0,
      pendingSat: 0,
    };
    if (running && this.wallet) {
      sweep = this.wallet.getSweepStatus();
    } else {
      // Stopped: best-effort from storage so the pill can still say "recovering".
      try {
        const pendingRaw = await storage.getItem(WalletController.SWEEP_PENDING_STORAGE_KEY);
        const pending = pendingRaw ? (JSON.parse(pendingRaw) as unknown[]) : [];
        const lastRaw = await storage.getItem(SWEEP_LAST_KEY);
        const last = lastRaw ? (JSON.parse(lastRaw) as { txid: string; sat: number; at: number }) : undefined;
        sweep = {
          needsAddress: false, // only knowable while running
          pendingCount: Array.isArray(pending) ? pending.length : 0,
          pendingSat: 0,
          ...(last ? { lastSweep: last } : {}),
        };
      } catch { /* defaults stand — display-only */ }
    }
    return {
      network,
      running,
      hasSeed,
      hasChannelState,
      createdNew,
      nodeId,
      balance,
      channels,
      usableChannels,
      peers,
      // Only meaningful while stopped — a running node has no outstanding start error.
      startError: running ? undefined : this.lastStartError,
      closes,
      sweep,
    };
  }

  // Build (but do not start) the wallet instance for the active network.
  private async buildWallet(): Promise<LibreListenerWallet> {
    const cfg = await this.getConfig();
    const storage = this.storageForNetwork(cfg.network);
    // Fall back to the network's public defaults so an unconfigured wallet still reaches its
    // bridge/esplora/RGS (mainnet ships the same infra as the extension); user config always wins.
    const bridgeUrl = cfg.bridgeUrl || defaultBridgeUrl(cfg.network);
    const socketProvider = createWebSocketStreamProvider(() => bridgeUrl);
    const wallet = new LibreListenerWallet({
      config: {
        network: cfg.network,
        // Always a defined string — falls back to a public per-network endpoint so start() never
        // crashes the SDK's EsploraSyncClient on an unconfigured wallet.
        esploraUrl: cfg.esploraUrl || defaultEsploraUrl(cfg.network),
        rapidGossipSyncUrl: cfg.rapidGossipSyncUrl || defaultRapidGossipSyncUrl(cfg.network),
        // The user-set node name (BOLT7 alias) shown by peer nodes instead of "Unknown";
        // delivered directly to connected peers by the SDK's node announcer.
        alias: cfg.nodeAlias || "Libre Listener Wallet",
        // Allowlist genuinely-0-conf LSPs (Megalith) so their channels are instant. The SDK only
        // 0-conf-accepts a zeroconf-typed open, so a confirmed open still falls back safely.
        trustedZeroConfPeers: zeroConfTrustedPubkeys(),
      } as unknown as ConstructorParameters<typeof LibreListenerWallet>[0]["config"],
      storage,
      socketProvider,
      // Per-origin single-node lock: only one tab/window may run this network's node at a time.
      acquireRunLock: () => acquireWebNodeLock(nodeLockName(dbNameForNetwork(cfg.network))),
      // Base-aware so the build works at a domain root (Cloudflare) or a project subpath.
      wasmUrl: `${import.meta.env.BASE_URL}liblightningjs.wasm`,
      logger: {
        info: (m, ...a) => console.log("[LDK]", m, ...a),
        warn: (m, ...a) => console.warn("[LDK]", m, ...a),
        error: (m, ...a) => console.error("[LDK]", m, ...a),
      },
    });
    // Clear the brand-new provenance marker once real channel state exists (mirrors the
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

  // Serialize concurrent start calls (auto-start racing a manual Start click must not build two
  // wallets over the same storage).
  private startingPromise?: Promise<{ nodeId: string; network: string }>;
  // Last node-start failure, captured at the source so the UI can show WHY the node isn't running —
  // otherwise an auto-start failure is a silent console log and looks like "it just didn't start".
  private lastStartError?: string;
  // Smoothing state for the usable-channel count shown in the UI (see core/usable-smoothing.ts).
  private usableView?: UsableSmootherState;
  // Auto-retry state for a NODE_ALREADY_RUNNING start (a stale single-node lock held by a
  // bfcache-frozen sibling page — see core/start-retry.ts).
  private nodeLockRetryTimer?: ReturnType<typeof setTimeout>;
  private nodeLockRetryAttempt = 0;

  async startNode(): Promise<{ nodeId: string; network: string }> {
    if (this.startingPromise) return this.startingPromise;
    if (this.isRunning()) return this.currentNode();
    this.startingPromise = this.doStartNode()
      .then((node) => {
        this.lastStartError = undefined; // cleared on any successful start
        this.clearNodeLockRetry();
        return node;
      })
      .catch((e) => {
        this.lastStartError = (e as Error)?.message || String(e);
        // A stale single-node lock (frozen sibling page) frees within seconds once iOS reaps it —
        // auto-retry a bounded number of times so it self-heals instead of latching a dead pill.
        // Any other failure stops the retry chain (it's not a transient lock contention).
        if (isNodeAlreadyRunningError(e)) this.scheduleNodeLockRetry();
        else this.clearNodeLockRetry();
        throw e;
      })
      .finally(() => {
        this.startingPromise = undefined;
      });
    return this.startingPromise;
  }

  private clearNodeLockRetry(): void {
    if (this.nodeLockRetryTimer) clearTimeout(this.nodeLockRetryTimer);
    this.nodeLockRetryTimer = undefined;
    this.nodeLockRetryAttempt = 0;
  }

  private scheduleNodeLockRetry(): void {
    if (this.nodeLockRetryTimer) return; // one retry pending at a time
    const plan = nodeLockRetryPlan(this.nodeLockRetryAttempt + 1);
    if (!plan.retry) return; // exhausted — leave the pill; the user can still tap Start
    this.nodeLockRetryAttempt += 1;
    this.nodeLockRetryTimer = setTimeout(() => {
      this.nodeLockRetryTimer = undefined;
      if (this.isRunning()) {
        this.nodeLockRetryAttempt = 0;
        return;
      }
      // startNode's catch re-schedules if it's still a lock error; the UI refreshes on success.
      void this.startNode()
        .then(() => this.emit("state-changed"))
        .catch(() => {});
    }, plan.delayMs);
  }

  // If the node is stopped because another context held the single-node lock (a stale frozen
  // sibling page), re-attempt now — e.g. on foreground-resume, when iOS has likely reaped it.
  // No-op otherwise. Best-effort; never throws into the caller.
  async retryStartIfLocked(): Promise<void> {
    if (this.isRunning() || !isNodeAlreadyRunningError(this.lastStartError ?? "")) return;
    await this.startNode()
      .then(() => this.emit("state-changed"))
      .catch(() => {});
  }

  // Start the node, enforcing the readiness guard: a seed with no channel state may start ONLY if
  // it was created brand-new here. A stateless restored/injected seed that auto-starts would
  // bootstrap an empty ChannelManager, connect the peer, and force-close the real channel on
  // channel_reestablish — the exact mainnet failure documented in the SDK gotchas.
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
    try {
      // start() already brings NWC up (nwc.init()+start()) — do NOT init it again here, or a second
      // LDK event listener gets registered and every payment event is processed twice.
      await wallet.start();
    } catch (e) {
      // Don't leave a half-built wallet assigned — otherwise setConfig ("stop the node first")
      // stays blocked and the user can't fix a bad config after a failed start.
      this.wallet = undefined;
      throw e;
    }
    await this.applySweepAddress();
    // Persist the resolved config + network pointer so an offline push wake can boot this node
    // (covers wallets created/started on pure defaults, incl. createWallet → startNode).
    await this.persistActiveNetwork(network);
    // Warm the routing graph best-effort (mainnet only serves RGS snapshots).
    void wallet.syncGossip().catch((e) => console.warn("[Gossip] initial sync failed:", e?.message || e));
    this.emit("state-changed");
    return this.currentNode();
  }

  // Load-time auto-start. NEVER throws — a failed or skipped auto-start leaves the controller
  // stopped and manual Start working. `flagRaw` is the raw localStorage AUTO_START_KEY value. The
  // plan mirrors assessStartReadiness: a stateless non-created-here seed is a silent skip here AND
  // still a hard error in startNode() (two layers against empty-node-force-closes-the-channel).
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
      await this.connectSavedOrDefaultPeer(network);
    } catch (e) {
      console.warn("[AutoStart] failed:", (e as Error)?.message || e);
    }
  }

  // Dial the saved (or network-default) peer with backoff. Shared by auto-start and restore:
  // the SDK's own start()-time redial only reaches counterparties in the persisted peer address
  // book (`peer_addresses`), which is NOT in a backup — so after a restore that book is empty and
  // the channel peer never gets dialed. This best-effort dial brings a channel opened to the
  // saved/default peer back online; a channel with a different peer (e.g. an LSP) still needs a
  // manual Connect-peer, which the peers screen surfaces.
  private async connectSavedOrDefaultPeer(network: string): Promise<void> {
    const cfg = await this.getConfig();
    const savedPeer = cfg.peer;
    const peerStr = savedPeer || defaultPeer(network);
    if (!peerStr) {
      console.warn("[Peer] no saved or default peer for this network — skipping peer connect");
      return;
    }
    if (!savedPeer) {
      console.warn("[Peer] no saved peer — dialing the network default, which may not be your channel peer");
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
          console.warn(`[Peer] connect attempt ${n} failed:`, (e as Error)?.message || e),
      }
    );
    if (connected) {
      this.emit("state-changed");
      console.log(`[Peer] node running, ${savedPeer ? "saved peer" : "default peer"} connected`);
    } else {
      console.warn("[Peer] peer connect gave up — use Connect peer in settings");
    }
  }

  // Wipe EVERYTHING — every network's wallet DB, the legacy un-namespaced DB, and the meta/active-
  // network pointer — for a true clean slate (the UI also clears localStorage + reloads). DESTRUCTIVE:
  // any funds in a live channel are lost; the UI gates this behind an explicit confirmation.
  // Uses clear() per store rather than deleteDatabase, which can block on open connections.
  async resetWallet(): Promise<{ network: string }> {
    if (this.startingPromise) await this.startingPromise.catch(() => {});
    const network = await this.activeNetwork();
    if (this.wallet) {
      await this.wallet.nwc.stop().catch((e) => console.warn("[NWC] stop failed:", e?.message || e));
      await this.wallet.stop();
      this.wallet = undefined;
    }
    const dbNames = [
      ...SUPPORTED_NETWORKS.map(dbNameForNetwork),
      "libre-wallet", // legacy un-namespaced DB (pre network-namespacing)
      META_DB_NAME,
    ];
    for (const name of dbNames) {
      await new IndexedDBStorageProvider(name)
        .clear()
        .catch((e) => console.warn(`[Reset] clearing ${name} failed:`, (e as Error)?.message || e));
    }
    this.emit("state-changed");
    return { network };
  }

  async stopNode(): Promise<void> {
    if (this.startingPromise) await this.startingPromise.catch(() => {});
    this.clearNodeLockRetry(); // an intentional stop cancels any pending lock-contention retry
    this.lastStartError = undefined; // intentional stop — not a start failure
    if (this.wallet) {
      await this.wallet.nwc.stop().catch((e) => console.warn("[NWC] stop failed:", e?.message || e));
      await this.wallet.stop();
      this.wallet = undefined;
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

  // Active network's seed as its 24-word BIP39 recovery phrase, for on-device display (never
  // logged). Reads storage directly, so it works whether or not the node is running.
  async getRecoveryPhrase(): Promise<{ mnemonic: string }> {
    return { mnemonic: seedHexToMnemonic(await this.readSeedHex()) };
  }

  // Active network's raw 64-hex seed (this app's native format). Same never-logged rules.
  async getSeed(): Promise<{ seedHex: string }> {
    return { seedHex: await this.readSeedHex() };
  }

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
    const early = restoreBlockReason({ running: !!this.wallet, restoring: this.restoring, targetHasChannelState: false });
    if (early) throw new Error(early);
    this.restoring = true;
    try {
      const probe = await this.buildWallet();
      const verified = await probe.verifyBackup(envelope, secret);
      if (!verified.ok) throw new Error("Backup could not be decrypted with that secret.");
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
      const wallet = await this.buildWallet();
      await wallet.importState(envelope, secret);
      this.wallet = wallet;
      await wallet.start();
      await this.applySweepAddress();
      await this.persistActiveNetwork(targetNetwork);
      void wallet.syncGossip().catch((e) => console.warn("[Gossip] initial sync failed:", e?.message || e));
      // Newer backups carry the peer address book, so start()'s redialChannelPeers() reconnects
      // every channel peer on its own. This dial of the saved/default peer is a best-effort fallback
      // for OLDER backups (made before peer_addresses was in the backup), whose book is empty.
      void this.connectSavedOrDefaultPeer(targetNetwork).catch((e) =>
        console.warn("[Peer] post-restore connect failed:", (e as Error)?.message || e),
      );
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

  // Fund-safety (iOS-eviction guard): does this encrypted backup envelope belong to THIS wallet —
  // i.e. does it decrypt with our current seed? Used to REFUSE overwriting a Google Drive backup
  // that belongs to a DIFFERENT wallet (after iOS evicts local storage the user can create a fresh
  // seed, and an auto-sync would otherwise clobber the old funded wallet's only cloud copy). Uses
  // the live wallet's verifyBackup (decrypt-only, no writes); returns false if it can't decrypt
  // with our seed, or if we have no running wallet to check against.
  async backupIsOurs(envelope: string): Promise<boolean> {
    if (!this.wallet) return false;
    try {
      const { seedHex } = await this.getSeed();
      const v = await this.wallet.verifyBackup(envelope, seedHex);
      return v.ok === true;
    } catch {
      return false;
    }
  }

  // ---- Force-close recovery: on-chain sweep address ----

  async getSweepAddress(): Promise<{ address: string }> {
    const storage = this.storageForNetwork(await this.activeNetwork());
    return { address: (await storage.getItem(SWEEP_ADDRESS_KEY)) || "" };
  }

  async setSweepAddress(address: string): Promise<{ address: string }> {
    const addr = (address || "").trim();
    const network = await this.activeNetwork();
    // Pass the active network so a wrong-chain address (e.g. tb1…/bcrt1… on mainnet) is rejected —
    // otherwise force-closed funds could sweep to a script that's unspendable on the real chain.
    if (addr) addressToScriptPubKey(addr, network); // throws on an invalid or wrong-network address
    const storage = this.storageForNetwork(network);
    if (addr) await storage.setItem(SWEEP_ADDRESS_KEY, addr);
    else await storage.removeItem(SWEEP_ADDRESS_KEY);
    if (this.wallet) this.wallet.setSweepDestination(addr ? addressToScriptPubKey(addr, network) : undefined);
    return { address: addr };
  }

  private async applySweepAddress(): Promise<void> {
    try {
      const network = await this.activeNetwork();
      const storage = this.storageForNetwork(network);
      const addr = (await storage.getItem(SWEEP_ADDRESS_KEY))?.trim();
      if (addr && this.wallet) this.wallet.setSweepDestination(addressToScriptPubKey(addr, network));
    } catch (e) {
      console.warn("[Sweep] could not apply saved sweep address:", (e as Error)?.message || e);
    }
  }

  // Top up: a BOLT11 invoice to receive into existing inbound capacity (open a channel first).
  async createInvoice(amountSats: number, memo?: string, expirySeconds?: number): Promise<{ paymentRequest: string }> {
    this.requireRunning();
    const amt = Math.floor(Number(amountSats));
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter an amount in sats greater than 0.");
    const paymentRequest = await this.wallet!.createInvoice(amt, memo || "Libre Listener Wallet top-up", expirySeconds || 3600);
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
    // Never coerce a bad limit to 0 (= unlimited). Reject non-finite/negative;
    // undefined defaults to 0 explicitly (callers pass a validated value).
    const limit = opts?.spendingLimitSats ?? 0;
    if (!Number.isFinite(limit) || limit < 0) {
      throw new Error("Spending limit must be a non-negative number of sats (0 for unlimited).");
    }
    const uri = await this.wallet!.nwc.createConnection(name || "Nostr Client App", {
      spendingLimitSats: limit,
      relayUrl: opts?.relayUrl,
      budgetRenewal: opts?.budgetRenewal,
      maxAmountSats: opts?.maxAmountSats,
      allowedMethods: opts?.allowedMethods,
      expiresAt: opts?.expiresAt,
    });
    this.emit("state-changed");
    return { uri };
  }

  async nwcListConnections(): Promise<NwcConnectionView[]> {
    this.requireRunning();
    const list = await this.wallet!.nwc.listConnections();
    // sanitizeConnection deliberately omits each pairing's `secret` — it never leaves the
    // wallet controller (pinned by core/nwc-connection-view.test.ts).
    return list.map(sanitizeConnection);
  }

  async nwcDeleteConnection(clientPubkey: string): Promise<void> {
    this.requireRunning();
    await this.wallet!.nwc.deleteConnection(clientPubkey);
    this.emit("state-changed");
  }

  // ---- Payment history + send ----

  // Forward-only payment history (SDK PaymentLogger is the source of truth). Works with the
  // node stopped: a fresh logger reads the persisted tx_* records straight from storage, so
  // the transactions sheet is usable offline/at rest.
  async getPayments(): Promise<PaymentRecord[]> {
    if (this.isRunning()) return this.wallet!.getPayments();
    const logger = new PaymentLogger({ storage: this.storageForNetwork(await this.activeNetwork()) });
    await logger.load();
    return logger.getRecords();
  }

  // Mirror of the SDK's SWEEP_PENDING_KEY ("sweep_pending_txs") for the stopped-node read.
  // Display-only: a drifted literal shows 0 pending, it can never affect the sweep itself.
  private static readonly SWEEP_PENDING_STORAGE_KEY = "sweep_pending_txs";

  // Channel-close history (SDK CloseLogger is the source of truth). Works with the node
  // STOPPED — fresh CloseLogger over storage, same pattern as getPayments().
  async getChannelCloses(): Promise<ChannelCloseRecord[]> {
    if (this.isRunning()) return this.wallet!.getChannelCloses();
    const log = new CloseLogger({ storage: this.storageForNetwork(await this.activeNetwork()) });
    await log.load();
    return log.getRecords();
  }

  // Serialize concurrent sends — a double-tap must never double-pay (the UI's guardedClick is
  // the first line; this is the controller-level backstop).
  private payingPromise?: Promise<{ preimage: string; amountSats: number }>;

  // Pay a pasted BOLT11 invoice or Lightning Address. Input-shape validation happens before
  // any wallet access so errors are cheap and specific; fund-safety semantics (timeout =
  // in-flight, never "failed") come from the SDK's payBolt11 / PaymentTimeoutError.
  async payLightning(
    input: string,
    opts?: { amountSats?: number; comment?: string }
  ): Promise<{ preimage: string; amountSats: number }> {
    const classified = classifySendInput(input);
    if (classified.kind === "invalid") {
      throw new Error("Enter a BOLT11 invoice or Lightning Address (name@domain).");
    }
    if (classified.kind === "lnaddress") {
      const amt = Math.floor(Number(opts?.amountSats));
      if (!Number.isFinite(amt) || amt <= 0) {
        throw new Error("Enter an amount in sats for a Lightning Address payment.");
      }
    }
    this.requireRunning();
    if (this.payingPromise) throw new Error("A payment is already in progress.");
    this.payingPromise = (async () => {
      let bolt11 = classified.value;
      if (classified.kind === "lnaddress") {
        const { invoice } = await resolveLnAddressInvoice({
          address: classified.value,
          amountMsat: Math.floor(Number(opts!.amountSats)) * 1000,
          comment: opts?.comment,
        });
        bolt11 = invoice;
      }
      return this.wallet!.payBolt11(bolt11);
    })();
    try {
      return await this.payingPromise;
    } finally {
      this.payingPromise = undefined;
      this.emit("state-changed");
    }
  }

  // ---- Peers ----

  // Rows for the Peers screen. Works stopped (address book only, all disconnected); running
  // adds live connections + channel counterparties. Combination is pure (core/peer-list.ts).
  async listPeers(): Promise<PeerRow[]> {
    if (this.isRunning()) {
      const [book, channels] = await Promise.all([
        this.wallet!.getPeerAddresses(),
        Promise.resolve(this.wallet!.getChannels()),
      ]);
      return buildPeerRows({
        connected: this.wallet!.getConnectedPeers(),
        book,
        channelPeers: channels.map((c) => c.counterpartyNodeId),
      });
    }
    const storage = this.storageForNetwork(await this.activeNetwork());
    const book = parsePeerAddressBook(await storage.getItem("peer_addresses"));
    return buildPeerRows({ connected: [], book, channelPeers: [] });
  }

  async connectPeer(pubkey: string, host: string, port: number): Promise<void> {
    this.requireRunning();
    await this.wallet!.connectPeer(pubkey, host, port);
    await this.savePeer(pubkey, host, port);
    this.emit("state-changed");
  }

  // Foreground-resume peer refresh (iOS zombie-socket fix). Drops + redials every desired peer so a
  // send after returning to the app doesn't route into a socket iOS killed while the page was
  // frozen. No-op when the node isn't running. Best-effort — never throws into the resume handler.
  async refreshPeerConnections(): Promise<void> {
    if (!this.wallet || !this.isRunning()) return;
    await this.wallet.refreshPeerConnections();
  }

  // Remember the last successfully connected peer so auto-start can redial it. Best-effort: a
  // persist failure must not fail the connect that already succeeded.
  private async savePeer(pubkey: string, host: string, port: number): Promise<void> {
    try {
      const network = await this.activeNetwork();
      const storage = this.storageForNetwork(network);
      const cfg = parseConfig(await storage.getItem(CONFIG_KEY));
      cfg.network = network as AppConfig["network"];
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

  async getChannels(): Promise<ChannelInfo[]> {
    this.requireRunning();
    return this.wallet!.getChannels();
  }

  // Buy inbound liquidity from a real mainnet LSP over the LSPS1 REST binding (Megalith / Olympus).
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

  async getLSPS1Order(apiUrl: string, orderId: string): Promise<unknown> {
    this.requireRunning();
    return this.wallet!.getLSPS1Order(apiUrl, orderId);
  }

  private currentNode(): { nodeId: string; network: string } {
    this.requireRunning();
    const mgr = this.wallet!.getChannelManager();
    return {
      nodeId: mgr ? bytesToHex(mgr.get_our_node_id()) : "",
      network: (this.wallet as unknown as { config?: { network?: string } }).config?.network ?? "",
    };
  }

  private requireRunning(): void {
    if (!this.isRunning()) throw new Error("Wallet is not running");
  }
}
