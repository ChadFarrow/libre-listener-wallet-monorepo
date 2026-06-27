import type {
  WalletConfig,
  LspProvider,
  JsonRpcRequest,
  Lsps1GetInfoResponse,
  Lsps1CreateOrderParams,
  Lsps1CreateOrderResponse,
  TlvRecord,
  SplitResult,
} from "@libre/shared";
import { encodeV4VTlvs } from "@libre/shared";

import {
  initializeWasmFromBinary,
  initializeWasmWebFetch,
  FeeEstimator,
  BroadcasterInterface,
  Logger as LdkLogger,
  KVStore,
  MonitorUpdatingPersister,
  ChainMonitor,
  PhantomKeysManager,
  UserConfig,
  ChainParameters,
  BestBlock,
  ChannelManager,
  NetworkGraph,
  RapidGossipSync,
  Result_u32GraphSyncErrorZ_OK,
  ProbabilisticScorer,
  ProbabilisticScoringDecayParameters,
  ProbabilisticScoringFeeParameters,
  MultiThreadedLockableScore,
  DefaultRouter,
  DefaultMessageRouter,
  Option_FilterZ,
  Filter,
  Network,
  Level,
  ConfirmationTarget,
  ChannelMonitor,
  Result_NetworkGraphDecodeErrorZ_OK,
  Result_ProbabilisticScorerDecodeErrorZ_OK,
  Result_C2Tuple_ThirtyTwoBytesChannelManagerZDecodeErrorZ_OK,
  Result_CVec_C2Tuple_ThirtyTwoBytesChannelMonitorZZIOErrorZ_OK,
  Option_CVec_ThirtyTwoBytesZZ,
  Option_SocketAddressZ,
  Init,
  UtilMethods,
  PeerManager,
  IgnoringMessageHandler,
  SocketDescriptor,
  SocketDescriptorInterface,
  Result_CVec_u8ZPeerHandleErrorZ,
  Result_CVec_u8ZPeerHandleErrorZ_OK,
  PhantomRouteHints,
  ChannelDetails,
  ChannelCounterparty,
  CounterpartyForwardingInfo,
  InitFeatures,
  RouteHint,
  RouteHintHop,
  RoutingFees,
  Option_u64Z,
  Option_u64Z_Some,
  Option_u32Z,
  Option_u16Z,
  Option_ChannelShutdownStateZ,
  Option_ThirtyTwoBytesZ,
  Result_Bolt11InvoiceSignOrCreationErrorZ,
  Result_Bolt11InvoiceSignOrCreationErrorZ_OK,
  Currency,
  ChannelId,
  Event,
  EventHandler,
  Result_NoneReplayEventZ,
  Option_ThirtyTwoBytesZ_Some,
  Event_PaymentClaimable,
  Result_ThirtyTwoBytesNoneZ_OK,
  PaymentParameters,
  RouteParameters,
  Retry,
  RecipientOnionFields,
  TwoTuple_u64CVec_u8ZZ,
  Result_ThirtyTwoBytesRetryableSendFailureZ_OK,
  Result_RecipientOnionFieldsNoneZ_OK,
} from "lightningdevkit";
import { StorageCache, bytesToHex, hexToBytes } from "./storage-cache";
import { getSecureRandomBytes } from "./crypto-utils";
import { EsploraSyncClient } from "./esplora-client";
import { LspsClient } from "./lsps-client";
import { NwcManager } from "./nwc-manager";
import { IndexedDBStorageProvider } from "./indexed-db-storage";
import { serializeAndEncrypt, serializeAndEncryptV1, decryptAndParse, BackupPayload } from "./state-backup";

export { IndexedDBStorageProvider };

export interface Logger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export interface SecureStorageProvider {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface WebSocketConnection {
  send(data: Uint8Array): void;
  close(): void;
  onmessage?: (data: Uint8Array) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
}

export interface WebSocketStreamProvider {
  connect(address: string, port: number): Promise<WebSocketConnection>;
}

let isWasmInitialized = false;

export class WebSocketDescriptor implements SocketDescriptorInterface {
  id: number;
  connection: WebSocketConnection;
  wallet: LibreListenerWallet;
  peerPubkey: string;
  isClosed: boolean = false;

  constructor(id: number, connection: WebSocketConnection, wallet: LibreListenerWallet, peerPubkey: string) {
    this.id = id;
    this.connection = connection;
    this.wallet = wallet;
    this.peerPubkey = peerPubkey;
  }

  send_data(data: Uint8Array, resume_read: boolean): number {
    if (this.isClosed) return 0;
    try {
      this.connection.send(data);
      return data.length;
    } catch (e) {
      this.disconnect_socket();
      return 0;
    }
  }

  disconnect_socket(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      this.connection.close();
    } catch (e) {}
    this.wallet.handleDisconnect(this);
  }

  eq(other: SocketDescriptor): boolean {
    return other.hash() === BigInt(this.id);
  }

  hash(): bigint {
    return BigInt(this.id);
  }
}

export class LibreListenerWallet {
  private config: WalletConfig;
  private logger?: Logger;
  private storage: SecureStorageProvider;
  private socketProvider: WebSocketStreamProvider;
  private isRunning: boolean = false;

  private wasmBinary?: Uint8Array;
  private wasmUrl?: string;

  private storageCache?: StorageCache;
  private syncClient?: EsploraSyncClient;
  private keysManager?: PhantomKeysManager;
  private chainMonitor?: ChainMonitor;
  private channelManager?: ChannelManager;
  private networkGraph?: NetworkGraph;
  private scorer?: ProbabilisticScorer;
  private lockableScore?: MultiThreadedLockableScore;
  private monitorUpdatingPersister?: MonitorUpdatingPersister;
  private peerManager?: PeerManager;
  private ldkLogger?: LdkLogger;

  private syncIntervalId?: any;
  private peerTickIntervalId?: any;
  private eventTickIntervalId?: any;
  private gossipIntervalId?: any;
  private gossipSyncPromise?: Promise<void>;
  private nodeAnnTickCount = 0;
  private nextDescriptorId: number = 1;
  private stateVersion: number = 0;
  private stateListeners: (() => void)[] = [];
  private connectedPeers: Map<string, WebSocketDescriptor> = new Map(); // hex pubkey -> descriptor
  private registryCache?: LspProvider[];
  private eventListeners: ((event: Event) => void)[] = [];
  public nwc: NwcManager;

  constructor(options: {
    config: WalletConfig;
    storage: SecureStorageProvider;
    socketProvider: WebSocketStreamProvider;
    logger?: Logger;
    wasmBinary?: Uint8Array;
    wasmUrl?: string;
  }) {
    this.config = options.config;
    this.storage = options.storage;
    this.socketProvider = options.socketProvider;
    this.logger = options.logger;
    this.wasmBinary = options.wasmBinary;
    this.wasmUrl = options.wasmUrl;
    this.nwc = new NwcManager(this, { logger: this.logger, storage: this.storage, network: this.config.network });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger?.warn("Wallet is already running");
      return;
    }
    this.logger?.info(`Starting LDK Node on network: ${this.config.network}`);

    // 1. Initialize WASM
    if (!isWasmInitialized) {
      if (this.wasmBinary) {
        await initializeWasmFromBinary(this.wasmBinary);
        isWasmInitialized = true;
      } else if (this.wasmUrl) {
        await initializeWasmWebFetch(this.wasmUrl);
        isWasmInitialized = true;
      } else {
        throw new Error("No WASM binary or URL provided for LDK WASM initialization");
      }
    }

    // 2. Load storage cache
    this.storageCache = new StorageCache(this.storage);
    await this.storageCache.load();

    const storedVersion = await this.storage.getItem("state_version");
    this.stateVersion = storedVersion ? parseInt(storedVersion, 10) || 0 : 0;

    const kvStore = KVStore.new_impl(this.storageCache);

    // 3. Setup key derivation & PhantomKeysManager
    let seedHex = await this.storage.getItem("ldk_seed");
    let seed: Uint8Array;
    if (!seedHex) {
      seed = getSecureRandomBytes(32);
      seedHex = bytesToHex(seed);
      await this.storage.setItem("ldk_seed", seedHex);
    } else {
      seed = hexToBytes(seedHex);
    }
    this.keysManager = PhantomKeysManager.constructor_new(
      seed,
      BigInt(Math.floor(Date.now() / 1000)),
      Math.floor(Math.random() * 100000),
      seed // cross_node_seed matches the seed
    );

    // 4. Setup Esplora sync client
    this.syncClient = new EsploraSyncClient(this.config.esploraUrl, this.logger);

    // 5. Instantiate LDK Logger, FeeEstimator, Broadcaster
    const self = this;
    this.ldkLogger = LdkLogger.new_impl({
      log(record) {
        const level = record.get_level();
        const args = record.get_args();
        const module = record.get_module_path();
        const message = `[LDK][${module}] ${args}`;
        
        switch (level) {
          case Level.LDKLevel_Error:
            self.logger?.error(message);
            break;
          case Level.LDKLevel_Warn:
            self.logger?.warn(message);
            break;
          case Level.LDKLevel_Info:
            self.logger?.info(message);
            break;
          case Level.LDKLevel_Debug:
            self.logger?.info(`[DEBUG] ${message}`);
            break;
          case Level.LDKLevel_Trace:
            self.logger?.info(`[TRACE] ${message}`);
            break;
          case Level.LDKLevel_Gossip:
          default:
            // Suppress verbose gossip in logs unless needed
            break;
        }
      }
    });

    const feeEstimator = FeeEstimator.new_impl({
      get_est_sat_per_1000_weight(confirmation_target) {
        return self.syncClient!.getFeeRate(confirmation_target);
      }
    });

    const broadcaster = BroadcasterInterface.new_impl({
      broadcast_transactions(txs) {
        for (const tx of txs) {
          self.syncClient!.broadcastTransaction(tx).catch(err => {
            self.logger?.error(`Failed to broadcast transaction: ${err.message}`);
          });
        }
      }
    });

    // 6. Setup MonitorUpdatingPersister & ChainMonitor
    this.monitorUpdatingPersister = MonitorUpdatingPersister.constructor_new(
      kvStore,
      this.ldkLogger,
      BigInt(10),
      this.keysManager.as_EntropySource(),
      this.keysManager.as_SignerProvider(),
      broadcaster,
      feeEstimator
    );
    const monitorPersister = this.monitorUpdatingPersister.as_Persist();

    this.chainMonitor = ChainMonitor.constructor_new(
      Option_FilterZ.constructor_some(Filter.new_impl(this.syncClient)),
      broadcaster,
      this.ldkLogger,
      feeEstimator,
      monitorPersister
    );

    // 7. Load existing channel monitors if any
    const monitorsReadRes = this.monitorUpdatingPersister.read_all_channel_monitors_with_updates();
    let channelMonitors: ChannelMonitor[] = [];
    if (monitorsReadRes.is_ok()) {
      const monitorsList = (monitorsReadRes as Result_CVec_C2Tuple_ThirtyTwoBytesChannelMonitorZZIOErrorZ_OK).res;
      channelMonitors = monitorsList.map(tuple => tuple.get_b());
      this.logger?.info(`Loaded ${channelMonitors.length} channel monitors from storage`);
      // LDK v0.1 does NOT auto-register monitors during ChannelManager::read — they must
      // be explicitly registered with ChainMonitor.watch_channel before the channel manager
      // is loaded, otherwise Update_channel calls will fail with "no such monitor registered".
      if (channelMonitors.length > 0) {
        const chainWatch = this.chainMonitor.as_Watch();
        // NOTE: monitors MUST be registered with the ChainMonitor BEFORE ChannelManager::read replays updates. The upstream LDK docs show registration AFTER read for the Rust API; do NOT "fix" the ordering to match — these JS bindings share monitor objects by reference and recovery breaks if read runs first.
        for (const monitor of channelMonitors) {
          const fundingTxoTuple = monitor.get_funding_txo();
          const fundingTxo = fundingTxoTuple.get_a();
          chainWatch.watch_channel(fundingTxo, monitor);
        }
        this.logger?.info(`Registered ${channelMonitors.length} channel monitors with ChainMonitor`);
      }
    }

    // 8. Load or construct NetworkGraph & Scorer
    let ldkNetwork: Network;
    switch (this.config.network) {
      case "mainnet":
        ldkNetwork = Network.LDKNetwork_Bitcoin;
        break;
      case "testnet":
        ldkNetwork = Network.LDKNetwork_Testnet;
        break;
      case "regtest":
        ldkNetwork = Network.LDKNetwork_Regtest;
        break;
      case "signet":
        ldkNetwork = Network.LDKNetwork_Signet;
        break;
      default:
        throw new Error(`Unsupported network: ${this.config.network}`);
    }

    const graphHex = await this.storage.getItem("network_graph");
    if (graphHex) {
      const readRes = NetworkGraph.constructor_read(hexToBytes(graphHex), this.ldkLogger);
      if (readRes.is_ok()) {
        this.networkGraph = (readRes as Result_NetworkGraphDecodeErrorZ_OK).res;
        this.logger?.info("Loaded NetworkGraph from storage");
      }
    }
    if (!this.networkGraph) {
      this.networkGraph = NetworkGraph.constructor_new(ldkNetwork, this.ldkLogger);
      this.logger?.info("Created new NetworkGraph");
    }

    const scorerHex = await this.storage.getItem("scorer");
    if (scorerHex) {
      const readRes = ProbabilisticScorer.constructor_read(
        hexToBytes(scorerHex),
        ProbabilisticScoringDecayParameters.constructor_default(),
        this.networkGraph,
        this.ldkLogger
      );
      if (readRes.is_ok()) {
        this.scorer = (readRes as Result_ProbabilisticScorerDecodeErrorZ_OK).res;
        this.logger?.info("Loaded Scorer from storage");
      }
    }
    if (!this.scorer) {
      this.scorer = ProbabilisticScorer.constructor_new(
        ProbabilisticScoringDecayParameters.constructor_default(),
        this.networkGraph,
        this.ldkLogger
      );
      this.logger?.info("Created new Scorer");
    }

    this.lockableScore = MultiThreadedLockableScore.constructor_new(this.scorer.as_Score());

    // 9. Setup Router and MessageRouter
    const router = DefaultRouter.constructor_new(
      this.networkGraph,
      this.ldkLogger,
      this.keysManager.as_EntropySource(),
      this.lockableScore.as_LockableScore(),
      ProbabilisticScoringFeeParameters.constructor_default()
    );

    const msgRouter = DefaultMessageRouter.constructor_new(
      this.networkGraph,
      this.keysManager.as_EntropySource()
    );

    // 10. Load or construct ChannelManager
    const userConfig = UserConfig.constructor_default();
    userConfig.set_manually_accept_inbound_channels(true);
    userConfig.get_channel_handshake_config().set_negotiate_anchors_zero_fee_htlc_tx(true);
    // Announced (public) channels must match the counterparty's preference. Default
    // private; enable when accepting public channels (e.g. from the Mutinynet faucet).
    userConfig.get_channel_handshake_config().set_announce_for_forwarding(this.config.announceChannels ?? false);

    const managerHex = await this.storage.getItem("channel_manager");
    if (managerHex) {
      const readRes = UtilMethods.constructor_C2Tuple_ThirtyTwoBytesChannelManagerZ_read(
        hexToBytes(managerHex),
        this.keysManager.as_EntropySource(),
        this.keysManager.as_NodeSigner(),
        this.keysManager.as_SignerProvider(),
        feeEstimator,
        this.chainMonitor.as_Watch(),
        broadcaster,
        router.as_Router(),
        msgRouter.as_MessageRouter(),
        this.ldkLogger,
        userConfig,
        channelMonitors
      );

      if (readRes.is_ok()) {
        const tuple = (readRes as Result_C2Tuple_ThirtyTwoBytesChannelManagerZDecodeErrorZ_OK).res;
        this.channelManager = tuple.get_b();
        this.logger?.info("Successfully loaded ChannelManager from storage");
      } else {
        this.logger?.error("Failed to load ChannelManager from storage, constructing fresh");
      }
    }

    if (!this.channelManager) {
      const tipHeight = await this.syncClient.fetchTipHeight();
      const tipHashHex = await this.syncClient.fetchTipHash();
      const tipHash = hexToBytes(tipHashHex).reverse();

      const bestBlock = BestBlock.constructor_new(tipHash, tipHeight);
      const params = ChainParameters.constructor_new(ldkNetwork, bestBlock);

      this.channelManager = ChannelManager.constructor_new(
        feeEstimator,
        this.chainMonitor.as_Watch(),
        broadcaster,
        router.as_Router(),
        msgRouter.as_MessageRouter(),
        this.ldkLogger,
        this.keysManager.as_EntropySource(),
        this.keysManager.as_NodeSigner(),
        this.keysManager.as_SignerProvider(),
        userConfig,
        params,
        Math.floor(Date.now() / 1000)
      );
      this.logger?.info("Successfully bootstrapped a fresh ChannelManager");
    }

    // 11. Setup PeerManager
    const ignoringHandler = IgnoringMessageHandler.constructor_new();
    this.peerManager = PeerManager.constructor_new(
      this.channelManager.as_ChannelMessageHandler(),
      ignoringHandler.as_RoutingMessageHandler(),
      ignoringHandler.as_OnionMessageHandler(),
      ignoringHandler.as_CustomMessageHandler(),
      Math.floor(Date.now() / 1000),
      getSecureRandomBytes(32),
      this.ldkLogger,
      this.keysManager.as_NodeSigner()
    );

    // 12. Initial sync with Esplora
    await this.syncClient.sync(this.channelManager, this.chainMonitor);

    // 13. Setup background loops
    this.syncIntervalId = setInterval(() => {
      if (this.channelManager && this.chainMonitor) {
        this.syncClient!.sync(this.channelManager, this.chainMonitor).catch(err => {
          this.logger?.error(`Background sync error: ${err.message}`);
        });
      }
    }, 30000);

    this.peerTickIntervalId = setInterval(() => {
      if (this.peerManager) {
        this.peerManager.timer_tick_occurred();
        this.peerManager.process_events();
        // Re-broadcast our node_announcement (~every 5 min) so the alias propagates
        // once a channel is publicly announced. No-op until then.
        if (this.config.alias && ++this.nodeAnnTickCount % 30 === 0) {
          this.broadcastNodeAnnouncement();
        }
      }
    }, 10000);

    const eventHandler = EventHandler.new_impl({
      handle_event: (event: Event) => {
        const name = event.constructor.name;
        this.logger?.info(`[LDK Event] Received event: ${name}`);

        for (const listener of this.eventListeners) {
          try {
            listener(event);
          } catch (e) {
            this.logger?.error(`Error in event listener: ${e instanceof Error ? e.message : e}`);
          }
        }

        if (event instanceof Event_PaymentClaimable) {
          const paymentHash = bytesToHex(event.payment_hash);
          this.logger?.info(`[LDK Event] PaymentClaimable for hash: ${paymentHash}`);
          this.storage.getItem(`preimage_${paymentHash}`).then((preimageHex) => {
            if (preimageHex) {
              this.logger?.info(`[LDK Event] Claiming payment with preimage: ${preimageHex}`);
              this.channelManager!.claim_funds(hexToBytes(preimageHex));
            } else {
              const preimageOpt = event.purpose.preimage();
              if (preimageOpt instanceof Option_ThirtyTwoBytesZ_Some) {
                this.logger?.info(`[LDK Event] Claiming payment with preimage from purpose: ${bytesToHex(preimageOpt.some)}`);
                this.channelManager!.claim_funds(preimageOpt.some);
              } else {
                this.logger?.warn(`[LDK Event] Preimage unknown for hash: ${paymentHash}`);
              }
            }
          });
        } else if (name === "Event_OpenChannelRequest") {
          const tempChanId = (event as any).temporary_channel_id;
          const counterparty = (event as any).counterparty_node_id;
          const counterpartyHex = bytesToHex(counterparty);
          let res;
          if (this.isZeroConfTrusted(counterpartyHex)) {
            // Trusted LSP/peer: a 0-conf JIT channel is usable immediately.
            this.logger?.info("[LDK Event] OpenChannelRequest from a trusted peer; trying zero-conf accept...");
            res = this.channelManager!.accept_inbound_channel_from_trusted_peer_0conf(tempChanId, counterparty, 0n);
            if (!res.is_ok()) {
              this.logger?.info("[LDK Event] Zero-conf unavailable; accepting as a normal channel (awaits confirmation).");
              res = this.channelManager!.accept_inbound_channel(tempChanId, counterparty, 0n);
            }
          } else {
            // Untrusted peer: never 0-conf (double-spend guardrail). Accept a normal,
            // confirmation-gated channel — still works, just not instant.
            this.logger?.info("[LDK Event] OpenChannelRequest from an untrusted peer; accepting as a normal channel (no 0-conf).");
            res = this.channelManager!.accept_inbound_channel(tempChanId, counterparty, 0n);
          }
          this.logger?.info(`[LDK Event] accept_inbound_channel result: ${res.is_ok()}`);
        } else if (name === "Event_PendingHTLCsForwardable") {
          this.logger?.info("[LDK Event] PendingHTLCsForwardable received. Processing forwards...");
          this.channelManager!.process_pending_htlc_forwards();
        } else if (name === "Event_ChannelPending") {
          this.logger?.info(`[LDK Event] Channel pending!`);
        } else if (name === "Event_ChannelReady") {
          this.logger?.info(`[LDK Event] Channel ready!`);
          this.broadcastNodeAnnouncement();
        } else if (name === "Event_PaymentClaimed") {
          this.logger?.info(`[LDK Event] Payment claimed!`);
        }

        return Result_NoneReplayEventZ.constructor_ok();
      }
    });

    this.eventTickIntervalId = setInterval(() => {
      if (this.channelManager) {
        this.channelManager.as_EventsProvider().process_pending_events(eventHandler);
        // Persist the ChannelManager whenever LDK signals it changed (channel opened,
        // payment sent/claimed, etc.), so channels survive an abrupt close — a browser
        // tab/reload never calls stop(), and the monitor alone can't resume a channel.
        if (this.channelManager.get_and_clear_needs_persistence()) {
          this.storage
            .setItem("channel_manager", bytesToHex(this.channelManager.write()))
            .catch((err) =>
              this.logger?.error(`Failed to persist channel_manager: ${err instanceof Error ? err.message : err}`)
            );
          this.notifyStateChanged();
        }
      }
      if (this.chainMonitor) {
        this.chainMonitor.as_EventsProvider().process_pending_events(eventHandler);
      }
    }, 1000);

    this.isRunning = true;

    // Kick off Rapid Gossip Sync in the background so the network graph populates
    // (enabling multi-hop routing) without blocking node startup, then refresh
    // periodically. No-op unless rapidGossipSyncUrl is configured.
    if (this.config.rapidGossipSyncUrl) {
      this.syncGossip().catch((err) =>
        this.logger?.error(`[RGS] Initial gossip sync failed: ${err instanceof Error ? err.message : err}`)
      );
      this.gossipIntervalId = setInterval(() => {
        if (this.isRunning) {
          this.syncGossip().catch((err) =>
            this.logger?.error(`[RGS] Gossip refresh failed: ${err instanceof Error ? err.message : err}`)
          );
        }
      }, 3600000); // hourly; RGS snapshots update ~daily
    }

    // Initialize and start Nostr Wallet Connect listeners
    await this.nwc.init();
    await this.nwc.start();
  }

  /**
   * Fetch a Rapid Gossip Sync snapshot from `rapidGossipSyncUrl` and apply it to the
   * NetworkGraph so the router can find multi-hop routes. Incremental: tracks the last
   * sync timestamp under the `rgs_timestamp` storage key. Safe to call repeatedly.
   */
  async syncGossip(): Promise<void> {
    // De-duplicate concurrent calls (the background refresh + a manual call) so we never
    // mutate the NetworkGraph from two places at once — LDK panics with a BorrowMutError.
    if (this.gossipSyncPromise) return this.gossipSyncPromise;
    this.gossipSyncPromise = this.doSyncGossip().finally(() => {
      this.gossipSyncPromise = undefined;
    });
    return this.gossipSyncPromise;
  }

  private async doSyncGossip(): Promise<void> {
    if (!this.config.rapidGossipSyncUrl || !this.networkGraph || !this.ldkLogger) return;
    const lastTs = parseInt((await this.storage.getItem("rgs_timestamp")) || "0", 10) || 0;
    const base = this.config.rapidGossipSyncUrl.replace(/\/$/, "");
    const url = `${base}/${lastTs}`;
    this.logger?.info(`[RGS] Fetching gossip snapshot from ${url}...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`RGS fetch failed: ${res.status} ${res.statusText}`);
    const snapshot = new Uint8Array(await res.arrayBuffer());
    const rgs = RapidGossipSync.constructor_new(this.networkGraph, this.ldkLogger);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const updateRes = rgs.update_network_graph_no_std(snapshot, Option_u64Z.constructor_some(nowSec));
    if (!updateRes.is_ok()) {
      const err = (updateRes as any).err?.toString?.() || "unknown error";
      throw new Error(`RGS apply failed: ${err}`);
    }
    const newTs = (updateRes as Result_u32GraphSyncErrorZ_OK).res;
    await this.storage.setItem("rgs_timestamp", String(newTs));
    const readOnly = this.networkGraph.read_only();
    const channelCount = readOnly.list_channels().length;
    readOnly.free(); // ReadOnlyNetworkGraph holds a read lock that must be freed.
    this.logger?.info(`[RGS] Gossip synced (ts=${newTs}); graph now has ${channelCount} channels.`);
  }

  getNetworkGraph(): NetworkGraph | undefined {
    return this.networkGraph;
  }

  /** Whether 0-conf JIT channels may be accepted from this counterparty (double-spend guard). */
  private isZeroConfTrusted(counterpartyHex: string): boolean {
    return (this.config.trustedZeroConfPeers ?? []).includes(counterpartyHex);
  }

  /** Subscribe to wallet state changes (channel opened, payment sent/claimed, etc.). */
  onStateChanged(cb: () => void): void {
    this.stateListeners.push(cb);
  }

  /** Bump the monotonic state version, persist it, and notify subscribers. */
  private notifyStateChanged(): void {
    this.stateVersion++;
    this.storage
      .setItem("state_version", String(this.stateVersion))
      .catch((err) => this.logger?.error(`Failed to persist state_version: ${err instanceof Error ? err.message : err}`));
    for (const l of this.stateListeners) {
      try {
        l();
      } catch (e) {
        this.logger?.error(`onStateChanged listener error: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /**
   * Create a BOLT11 invoice to receive a payment (sats). Returns the invoice string.
   */
  async createInvoice(amountSats: number, description = "Libre Listener Wallet", expirySeconds = 3600): Promise<string> {
    const { invoice } = await this.buildInvoice(BigInt(Math.round(amountSats)) * 1000n, description, expirySeconds);
    this.logger?.info(`[Receive] Created BOLT11 invoice for ${amountSats} sats`);
    return invoice;
  }

  /**
   * Single BOLT11 builder shared by createInvoice / requestLSPS2Invoice / NWC make_invoice.
   * Uses the ChannelManager creator, which auto-embeds route hints for our (possibly
   * unannounced/private) channels, so a counterparty can pay a private node. Generates a
   * preimage if one isn't supplied, and persists it (preimage_<hash>) so the
   * Event_PaymentClaimable handler can claim the payment. Returns invoice + hash + preimage.
   */
  private async buildInvoice(
    amountMsat: bigint,
    description: string,
    expirySeconds: number,
    preimage?: Uint8Array
  ): Promise<{ invoice: string; paymentHash: string; preimage: string }> {
    if (!this.channelManager) throw new Error("Wallet not started");
    const pre = preimage ?? getSecureRandomBytes(32);
    const paymentHashBuf = await crypto.subtle.digest("SHA-256", pre as any);
    const paymentHashHex = bytesToHex(new Uint8Array(paymentHashBuf));
    const invoiceRes = UtilMethods.constructor_create_invoice_from_channelmanager_with_payment_hash(
      this.channelManager,
      Option_u64Z.constructor_some(amountMsat),
      description,
      expirySeconds,
      hexToBytes(paymentHashHex),
      Option_u16Z.constructor_some(42)
    );
    if (!invoiceRes.is_ok()) throw new Error("Failed to create BOLT11 invoice");
    const invoice = (invoiceRes as Result_Bolt11InvoiceSignOrCreationErrorZ_OK).res.to_str();
    await this.storage.setItem(`preimage_${paymentHashHex}`, bytesToHex(pre));
    return { invoice, paymentHash: paymentHashHex, preimage: bytesToHex(pre) };
  }

  /**
   * Broadcast a signed node_announcement carrying our alias (name) + color so peers
   * show a name instead of "Unknown". Lightning only relays this once we have a public
   * (announced) channel, so it's a no-op until then; the peer tick re-broadcasts
   * periodically so the name propagates after the channel is announced (~6 confs).
   */
  private broadcastNodeAnnouncement(): void {
    if (!this.config.alias || !this.peerManager) return;
    const aliasBytes = new Uint8Array(32);
    aliasBytes.set(new TextEncoder().encode(this.config.alias).slice(0, 32));
    const rgb = new Uint8Array([0x7a, 0x5a, 0xf5]); // brand purple
    try {
      this.peerManager.broadcast_node_announcement(rgb, aliasBytes, []);
      this.logger?.info(`[LDK] Broadcast node_announcement (alias "${this.config.alias}")`);
    } catch (err) {
      this.logger?.error(`broadcast_node_announcement failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async persistManagerState(): Promise<void> {
    if (this.channelManager && this.networkGraph && this.scorer) {
      try {
        this.logger?.info("Saving manager/graph/scorer state to storage...");
        await this.storage.setItem("channel_manager", bytesToHex(this.channelManager.write()));
        await this.storage.setItem("network_graph", bytesToHex(this.networkGraph.write()));
        await this.storage.setItem("scorer", bytesToHex(this.scorer.write()));
      } catch (err) {
        this.logger?.error(`Failed to save state: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger?.warn("Wallet is not running");
      return;
    }
    this.logger?.info("Stopping LDK Node...");

    // Stop Nostr Wallet Connect listeners
    await this.nwc.stop();

    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = undefined;
    }

    if (this.peerTickIntervalId) {
      clearInterval(this.peerTickIntervalId);
      this.peerTickIntervalId = undefined;
    }

    if (this.eventTickIntervalId) {
      clearInterval(this.eventTickIntervalId);
      this.eventTickIntervalId = undefined;
    }

    if (this.gossipIntervalId) {
      clearInterval(this.gossipIntervalId);
      this.gossipIntervalId = undefined;
    }

    // Disconnect peers
    for (const descriptor of this.connectedPeers.values()) {
      descriptor.disconnect_socket();
    }
    this.connectedPeers.clear();

    // Persist final states
    await this.persistManagerState();

    // Free pointers to prevent WASM leaks
    this.channelManager = undefined;
    this.chainMonitor = undefined;
    this.keysManager = undefined;
    this.networkGraph = undefined;
    this.scorer = undefined;
    this.lockableScore = undefined;
    this.monitorUpdatingPersister = undefined;
    this.peerManager = undefined;
    this.ldkLogger = undefined;

    this.isRunning = false;
  }

  async sync(): Promise<void> {
    if (!this.isRunning || !this.channelManager || !this.chainMonitor) {
      throw new Error("Wallet is not running");
    }
    await this.syncClient!.sync(this.channelManager, this.chainMonitor);
  }

  status(): "Stopped" | "Running" {
    return this.isRunning ? "Running" : "Stopped";
  }

  getStateVersion(): number {
    return this.stateVersion;
  }

  async exportState(opts?: { passphrase?: string }): Promise<string> {
    // Flush the latest in-memory manager/graph/scorer so the backup is current.
    if (this.isRunning) {
      await this.persistManagerState();
    }
    const seedHex = await this.storage.getItem("ldk_seed");
    if (!seedHex) {
      throw new Error("Cannot export: no wallet seed found in storage");
    }

    const entries: Record<string, string> = {};
    // Direct (non-KVStore) keys written by the wallet itself.
    const directKeys = ["ldk_seed", "channel_manager", "network_graph", "scorer", "ldk_keys_index", "state_version"];
    for (const k of directKeys) {
      const v = await this.storage.getItem(k);
      if (v !== null) entries[k] = v;
    }
    // KVStore-managed keys (channel monitors etc.) tracked in the index.
    const indexStr = entries["ldk_keys_index"];
    if (indexStr) {
      let keyList: string[] = [];
      try {
        keyList = JSON.parse(indexStr);
      } catch (err) {
        throw new Error(`Cannot export: ldk_keys_index is malformed — ${(err as Error).message}`);
      }
      for (const k of keyList) {
        const v = await this.storage.getItem(k);
        if (v !== null) entries[k] = v;
      }
    }

    const payload: BackupPayload = {
      version: 1,
      network: this.config.network,
      exportedAt: Date.now(),
      entries,
    };
    // v2 (passphrase + seed dual-wrap) when a passphrase is supplied; otherwise
    // legacy v1 (seed-only) for back-compat/tests.
    if (opts?.passphrase) {
      return serializeAndEncrypt(payload, { passphrase: opts.passphrase, seedHex });
    }
    return serializeAndEncryptV1(payload, seedHex);
  }

  /**
   * Restore a backup into storage. `secret` may be the backup passphrase (v2) or
   * a 64-hex seed (v2 or legacy v1) — decryptAndParse auto-detects.
   */
  async importState(envelope: string, secret: string): Promise<void> {
    if (this.isRunning) {
      throw new Error("Cannot import while running — create a fresh wallet and import before start()");
    }
    const payload = await decryptAndParse(envelope, secret);
    if (payload.network !== this.config.network) {
      throw new Error(`Backup network mismatch: backup is "${payload.network}" but wallet is configured for "${this.config.network}"`);
    }
    for (const [k, v] of Object.entries(payload.entries)) {
      await this.storage.setItem(k, v);
    }
  }

  /**
   * Decrypt a backup WITHOUT writing to storage, to prove recoverability before
   * funding. Never returns secret material — only booleans/metadata.
   */
  async verifyBackup(envelope: string, secret: string): Promise<{
    ok: boolean;
    network?: string;
    hasSeed: boolean;
    seedMatches?: boolean;
    entryKeys: string[];
    error?: string;
  }> {
    try {
      const payload = await decryptAndParse(envelope, secret);
      const seedInBackup = payload.entries["ldk_seed"];
      const isHex = /^[0-9a-fA-F]{64}$/.test(secret);
      return {
        ok: true,
        network: payload.network,
        hasSeed: !!seedInBackup,
        seedMatches: isHex ? seedInBackup?.toLowerCase() === secret.toLowerCase() : undefined,
        entryKeys: Object.keys(payload.entries),
      };
    } catch (e) {
      return { ok: false, hasSeed: false, entryKeys: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  // --- exposed properties & methods ---

  addEventListener(listener: (event: Event) => void): void {
    this.eventListeners.push(listener);
  }

  removeEventListener(listener: (event: Event) => void): void {
    this.eventListeners = this.eventListeners.filter(l => l !== listener);
  }

  getChannelManager(): ChannelManager | undefined {
    return this.channelManager;
  }

  getChainMonitor(): ChainMonitor | undefined {
    return this.chainMonitor;
  }

  getSyncClient(): EsploraSyncClient | undefined {
    return this.syncClient;
  }

  getKeysManager(): PhantomKeysManager | undefined {
    return this.keysManager;
  }

  getPeerManager(): PeerManager | undefined {
    return this.peerManager;
  }

  getConnectedPeers(): string[] {
    return Array.from(this.connectedPeers.keys());
  }

  // --- Peer Connection Adapter ---

  async connectPeer(pubkey: string, host: string, port: number): Promise<void> {
    if (!this.peerManager) {
      throw new Error("Wallet is not running");
    }

    this.logger?.info(`Connecting to peer: ${pubkey}@${host}:${port}`);

    // If already connected, do nothing
    if (this.connectedPeers.has(pubkey)) {
      this.logger?.info(`Peer ${pubkey} is already connected`);
      return;
    }

    const connection = await this.socketProvider.connect(host, port);
    const descriptorId = this.nextDescriptorId++;
    const descriptorImpl = new WebSocketDescriptor(descriptorId, connection, this, pubkey);
    const descriptor = SocketDescriptor.new_impl(descriptorImpl);

    connection.onmessage = (data) => {
      if (this.peerManager) {
        const res = this.peerManager.read_event(descriptor, data);
        if (res.is_ok()) {
          const bytes = (res as Result_CVec_u8ZPeerHandleErrorZ_OK).res;
          if (bytes.length > 0) {
            descriptorImpl.send_data(bytes, false);
          }
        } else {
          this.logger?.error(`Failed to read event for peer ${pubkey}, disconnecting`);
          descriptorImpl.disconnect_socket();
        }
        this.peerManager.process_events();
      }
    };

    connection.onclose = () => {
      descriptorImpl.disconnect_socket();
    };

    connection.onerror = (err) => {
      this.logger?.error(`WebSocket error for peer ${pubkey}: ${err.message}`);
      descriptorImpl.disconnect_socket();
    };

    const initialBytesResult = this.peerManager.new_outbound_connection(
      hexToBytes(pubkey),
      descriptor,
      Option_SocketAddressZ.constructor_none()
    );

    if (initialBytesResult.is_ok()) {
      const initialBytes = (initialBytesResult as Result_CVec_u8ZPeerHandleErrorZ_OK).res;
      descriptorImpl.send_data(initialBytes, false);
      this.connectedPeers.set(pubkey, descriptorImpl);
      this.logger?.info(`Successfully connected to peer: ${pubkey}`);
    } else {
      descriptorImpl.disconnect_socket();
      throw new Error("Failed to initialize outbound connection in PeerManager");
    }
  }

  handleDisconnect(desc: WebSocketDescriptor): void {
    if (this.connectedPeers.get(desc.peerPubkey)?.id === desc.id) {
      this.connectedPeers.delete(desc.peerPubkey);
      this.logger?.info(`Disconnected peer: ${desc.peerPubkey}`);
    }
    if (this.peerManager) {
      const sdkDescriptor = SocketDescriptor.new_impl(desc);
      this.peerManager.socket_disconnected(sdkDescriptor);
      this.peerManager.process_events();
    }
  }

  // --- LSP Discovery Client ---

  async fetchLspRegistry(url: string): Promise<LspProvider[]> {
    try {
      this.logger?.info(`Fetching LSP registry from: ${url}`);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch LSP registry: ${res.statusText}`);
      }
      const data = await res.json() as LspProvider[];
      this.registryCache = data;
      return data;
    } catch (e) {
      this.logger?.error(`Failed to fetch LSP registry: ${e instanceof Error ? e.message : e}`);
      if (this.registryCache) {
        this.logger?.info("Using cached LSP registry");
        return this.registryCache;
      }
      throw e;
    }
  }

  // --- LSPS2 JIT Channel Implementation ---

  async requestLSPS2Invoice(options: {
    amountSats: number;
    description: string;
    lsp: LspProvider;
  }): Promise<string> {
    if (!this.channelManager || !this.keysManager || !this.peerManager || !this.ldkLogger) {
      throw new Error("Wallet is not running");
    }

    const { amountSats, description, lsp } = options;
    const amountMsat = BigInt(amountSats * 1000);

    this.logger?.info(`[LSPS2] Requesting JIT invoice for ${amountSats} sats from LSP ${lsp.name}`);

    // 1. Connect to LSP peer if not connected
    const lspConnString = lsp.connection_string; // format: pubkey@host:port
    const [pubkey, addressPort] = lspConnString.split("@");
    const [host, portStr] = addressPort.split(":");
    const port = parseInt(portStr, 10);

    await this.connectPeer(pubkey, host, port);

    // 2. Query LSPS2 API
    const lspsClient = new LspsClient(lsp.api_url, this.logger);

    // a. Get versions
    const versionRes = await lspsClient.request<{}, { versions: number[] }>(
      "lsps2.get_versions",
      {}
    );
    if (!versionRes.versions.includes(1)) {
      throw new Error("LSP does not support LSPS2 version 1");
    }

    // b. Get info
    const infoRes = await lspsClient.request<
      { version: number; client_node_id: string },
      { opening_fee_params_menu: any[]; min_payment_size_msat: string; max_payment_size_msat: string }
    >("lsps2.get_info", {
      version: 1,
      client_node_id: bytesToHex(this.channelManager.get_our_node_id()),
    });

    if (!infoRes.opening_fee_params_menu || infoRes.opening_fee_params_menu.length === 0) {
      throw new Error("LSP LSPS2 opening fee params menu is empty");
    }

    // Select the first fee param menu item as default
    const selectedFeeParams = infoRes.opening_fee_params_menu[0];

    // c. Register JIT Payment with LSP (lsps2.buy)
    const preimage = getSecureRandomBytes(32);
    const paymentHash = await crypto.subtle.digest("SHA-256", preimage as any);
    const paymentHashHex = bytesToHex(new Uint8Array(paymentHash));

    const buyRes = await lspsClient.request<
      { version: number; opening_fee_params: any; payment_hash: string; client_node_id: string },
      { jit_channel_scid: string; cltv_expiry_delta: number }
    >("lsps2.buy", {
      version: 1,
      opening_fee_params: selectedFeeParams,
      payment_hash: paymentHashHex,
      client_node_id: bytesToHex(this.channelManager.get_our_node_id()),
    });

    // 3. Generate the BOLT11 invoice with the same payment hash via the shared builder
    // (route hints auto-added; preimage persisted for the claim path).
    const { invoice: invoiceStr } = await this.buildInvoice(amountMsat, description, 3600, preimage);
    this.logger?.info(`[LSPS2] Generated standard JIT invoice: ${invoiceStr}`);

    return invoiceStr;
  }

  // --- LSPS1 Inbound Capacity Purchase ---

  async purchaseLSPS1Capacity(options: {
    amountSats: number;
    lsp: LspProvider;
  }): Promise<string> {
    if (!this.channelManager) {
      throw new Error("Wallet is not running");
    }

    const { amountSats, lsp } = options;
    this.logger?.info(`[LSPS1] Purchasing ${amountSats} sats inbound capacity from LSP ${lsp.name}`);

    const lspsClient = new LspsClient(lsp.api_url, this.logger);

    // a. Get info
    const infoRes = await lspsClient.request<{}, Lsps1GetInfoResponse>(
      "lsps1.get_info",
      {}
    );

    const amountSatStr = amountSats.toString();
    if (BigInt(amountSatStr) < BigInt(infoRes.min_channel_balance_sat) ||
        BigInt(amountSatStr) > BigInt(infoRes.max_channel_balance_sat)) {
      throw new Error(`Requested amount ${amountSats} sat is outside LSP bounds [${infoRes.min_channel_balance_sat}, ${infoRes.max_channel_balance_sat}]`);
    }

    // b. Create order
    const orderRes = await lspsClient.request<Lsps1CreateOrderParams, Lsps1CreateOrderResponse>(
      "lsps1.create_order",
      {
        lsp_balance_sat: amountSatStr,
        client_balance_sat: "0",
        client_node_id: bytesToHex(this.channelManager.get_our_node_id()),
        channel_expiry_blocks: infoRes.min_channel_expiry_blocks,
        announce_channel: false,
      }
    );

    this.logger?.info(`[LSPS1] Order placed successfully: ${orderRes.order_id}. Pay invoice: ${orderRes.invoice}`);
    return orderRes.invoice;
  }

  // --- Value-for-Value Keysend & Splits Implementation ---

  async sendKeysendPayment(options: {
    destinationPubkey: string;
    amountSats: number;
    customRecords?: Record<number, string | Uint8Array>;
    retryAttempts?: number;
    preimage?: Uint8Array;
  }): Promise<{ ok: true; paymentId: string; paymentHash: string } | { ok: false; error: string }> {
    if (!this.isRunning || !this.channelManager) {
      throw new Error("Wallet is not running");
    }

    const { destinationPubkey, amountSats, customRecords, retryAttempts } = options;
    this.logger?.info(`[Keysend] Sending ${amountSats} sats to ${destinationPubkey}...`);

    try {
      const destPubkeyBytes = hexToBytes(destinationPubkey);
      const preimage = options.preimage ?? getSecureRandomBytes(32);
      const paymentId = getSecureRandomBytes(32);

      const paymentHash = await crypto.subtle.digest("SHA-256", preimage as any);
      const paymentHashHex = bytesToHex(new Uint8Array(paymentHash));

      // Construct custom TLV records
      const tlvTuples: TwoTuple_u64CVec_u8ZZ[] = [];
      if (customRecords) {
        const sortedKeys = Object.keys(customRecords)
          .map((k) => parseInt(k, 10))
          .filter((k) => !isNaN(k))
          .sort((a, b) => a - b);

        for (const key of sortedKeys) {
          const val = customRecords[key];
          const valBytes = typeof val === "string" ? new TextEncoder().encode(val) : val;
          tlvTuples.push(TwoTuple_u64CVec_u8ZZ.constructor_new(BigInt(key), valBytes));
        }
      }

      let onionFields = RecipientOnionFields.constructor_spontaneous_empty();
      if (tlvTuples.length > 0) {
        const onionRes = onionFields.with_custom_tlvs(tlvTuples);
        if (!onionRes.is_ok()) {
          return { ok: false, error: "Failed to construct custom TLVs on onion fields" };
        }
        onionFields = (onionRes as Result_RecipientOnionFieldsNoneZ_OK).res;
      }

      const paymentParams = PaymentParameters.constructor_for_keysend(
        destPubkeyBytes,
        42,
        false
      );

      const routeParams = RouteParameters.constructor_from_payment_params_and_value(
        paymentParams,
        BigInt(amountSats * 1000)
      );

      const attempts = retryAttempts ?? 10;
      const retryStrategy = Retry.constructor_attempts(attempts);

      const sendRes = this.channelManager.send_spontaneous_payment(
        Option_ThirtyTwoBytesZ.constructor_some(preimage),
        onionFields,
        paymentId,
        routeParams,
        retryStrategy
      );

      if (sendRes.is_ok()) {
        this.logger?.info(`[Keysend] Payment successfully initiated with ID: ${bytesToHex(paymentId)}, hash: ${paymentHashHex}`);
        // Store the preimage so we can reference it when Event_PaymentClaimable triggers (if we pay ourselves)
        await this.storage.setItem(`preimage_${paymentHashHex}`, bytesToHex(preimage));
        return {
          ok: true,
          paymentId: bytesToHex(paymentId),
          paymentHash: paymentHashHex,
        };
      } else {
        const error = (sendRes as any).err?.toString() || "Unknown LDK error";
        this.logger?.error(`[Keysend] Payment failed to initiate: ${error}`);
        return {
          ok: false,
          error: `Payment failed to initiate: ${error}`,
        };
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.logger?.error(`[Keysend] Error during payment generation: ${errMsg}`);
      return {
        ok: false,
        error: errMsg,
      };
    }
  }

  async sendSplitPayments(splits: SplitResult[]): Promise<{
    ok: boolean;
    results: Array<{
      destinationPubkey: string;
      amountSats: number;
      result: { ok: true; paymentId: string; paymentHash: string } | { ok: false; error: string };
    }>;
  }> {
    this.logger?.info(`[Keysend] Initiating multi-recipient splits (${splits.length} destinations)...`);
    const promises = splits.map(async (split) => {
      const customRecords: Record<number, Uint8Array> = {};
      for (const rec of split.tlvRecords) {
        customRecords[rec.key] = rec.value;
      }

      const res = await this.sendKeysendPayment({
        destinationPubkey: split.destinationPubkey,
        amountSats: split.amountSats,
        customRecords,
      });

      return {
        destinationPubkey: split.destinationPubkey,
        amountSats: split.amountSats,
        result: res,
      };
    });

    const results = await Promise.all(promises);
    const anyFailed = results.some((r) => !r.result.ok);

    return {
      ok: !anyFailed,
      results,
    };
  }
}

export { StorageCache, bytesToHex, hexToBytes } from "./storage-cache";
export { EsploraSyncClient } from "./esplora-client";
export type { WalletConfig } from "@libre/shared";
export { LspsClient } from "./lsps-client";
