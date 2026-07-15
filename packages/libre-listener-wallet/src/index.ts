import type {
  WalletConfig,
  LspProvider,
  JsonRpcRequest,
  Lsps1RestOrderResponse,
  TlvRecord,
  SplitResult,
} from "@libre/shared";
import { encodeV4VTlvs, DEFAULT_INVOICE_EXPIRY_SECONDS, resolveInvoiceExpiry } from "@libre/shared";
import { Lsps1RestClient, clampExpiryBlocks, orderInvoice } from "./lsps1-rest-client";

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
  Option_u32Z_Some,
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
  ReplayEvent,
  Option_ThirtyTwoBytesZ_Some,
  Event_PaymentClaimable,
  Event_OpenChannelRequest,
  Event_PendingHTLCsForwardable,
  Event_ChannelPending,
  Event_ChannelReady,
  Event_PaymentClaimed,
  Event_PaymentSent,
  Event_PaymentFailed,
  Event_SpendableOutputs,
  Event_ChannelClosed,
  ClosureReason,
  ClosureReason_CounterpartyForceClosed,
  ClosureReason_HolderForceClosed,
  ClosureReason_LegacyCooperativeClosure,
  ClosureReason_CounterpartyInitiatedCooperativeClosure,
  ClosureReason_LocallyInitiatedCooperativeClosure,
  ClosureReason_CommitmentTxConfirmed,
  ClosureReason_OutdatedChannelManager,
  Result_ThirtyTwoBytesNoneZ_OK,
  PaymentParameters,
  RouteParameters,
  Retry,
  RecipientOnionFields,
  TwoTuple_u64CVec_u8ZZ,
  Result_ThirtyTwoBytesRetryableSendFailureZ_OK,
  Result_RecipientOnionFieldsNoneZ_OK,
  Bolt11Invoice,
  Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK,
} from "lightningdevkit";
import { StorageCache, bytesToHex, hexToBytes, parseSeedHex } from "./storage-cache";
import { NodeAnnouncer } from "./node-announcer";
import { peersNeedingAnnouncement } from "./node-announcement";
import { createDurablePersist } from "./durable-persist";
import { getSecureRandomBytes } from "./crypto-utils";
import { hasRouteHint, appendRouteHints, type HintHop } from "./bolt11-hints";
import { buildUserConfig } from "./user-config";
import { selectHintChannels, prioritizeHints, forwardingInfoFromLdk, type HintableChannel } from "./hint-selection";
import { EsploraSyncClient, ldkTxidToDisplay } from "./esplora-client";
import { LspsClient } from "./lsps-client";
import { NwcManager } from "./nwc-manager";
import { IndexedDBStorageProvider } from "./indexed-db-storage";
import { serializeAndEncrypt, serializeAndEncryptV1, decryptAndParse, verifyBackupEnvelope, BackupPayload } from "./state-backup";
export { verifyBackupEnvelope, type BackupVerification } from "./state-backup";
import { BACKUP_DIRECT_KEYS } from "./backup-keys";
import { VssClient } from "./vss-client";
import { VssMirror, deriveVssStoreId, VSS_STATE_BACKUP_KEY } from "./vss-mirror";
import { VssDeviceLease } from "./vss-device-lease";
import { CrossDeviceLockError } from "./cross-device-lease-error";
import { reconnectDelayMs, shouldRedialNow } from "./peer-reconnect";
import { pollUntil } from "./await-usable";
import { normalizeBackupSecret } from "./seed-phrase";
import { PaymentLogger, boostNoteFromCustomRecords, TX_KEY_PREFIX } from "./payment-log";
import { CloseLogger, type ChannelCloseRecord } from "./close-log";
import type { ChannelCloseReason } from "./close-log";
import type { PaymentRecord } from "@libre/shared";
import {
  parseHighwater,
  serializeHighwater,
  mergeHighwater,
  findRegression,
  ChannelStateRegressionError,
  type Highwater,
} from "./state-highwater";
export { ChannelStateRegressionError } from "./state-highwater";
import { NodeAlreadyRunningError } from "./node-lock-error";
export { NodeAlreadyRunningError } from "./node-lock-error";
import { PaymentTimeoutError } from "./payment-timeout-error";
export { PaymentTimeoutError } from "./payment-timeout-error";

export { IndexedDBStorageProvider };

/** Map an LDK ClosureReason to a stable, minification-safe label. Exported for tests. */
export function closureReasonLabel(reason: unknown): ChannelCloseReason {
  if (reason instanceof ClosureReason_CounterpartyForceClosed) return "counterparty-force-closed";
  if (reason instanceof ClosureReason_HolderForceClosed) return "we-force-closed";
  if (reason instanceof ClosureReason_CommitmentTxConfirmed) return "force-closed";
  if (
    reason instanceof ClosureReason_LegacyCooperativeClosure ||
    reason instanceof ClosureReason_CounterpartyInitiatedCooperativeClosure ||
    reason instanceof ClosureReason_LocallyInitiatedCooperativeClosure
  ) {
    return "cooperative";
  }
  if (reason instanceof ClosureReason_OutdatedChannelManager) return "outdated-manager";
  return "other";
}

export interface Logger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

export interface SecureStorageProvider {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  // Optional key enumeration. IndexedDBStorageProvider implements it; providers that
  // don't (e.g. a mobile Keychain) simply can't back the payment history (it stays
  // empty) — no crash. Used by PaymentLogger to load per-record `tx_*` keys.
  keys?(): Promise<string[]>;
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

export interface ChannelInfo {
  channelId: string;
  counterpartyNodeId: string;
  capacitySat: number;
  outboundSendableSat: number;
  inboundSat: number;
  isUsable: boolean;
  isChannelReady: boolean;
  // On-chain funding outpoint, once the channel has a funding tx. txid is big-endian DISPLAY order
  // (block-explorer order) — pass straight to mempool.space. Undefined while still pre-funding.
  fundingTxid?: string;
  fundingOutputIndex?: number;
  // Funding confirmation progress while a channel is still pending (undefined once ready / for 0-conf).
  confirmations?: number;
  confirmationsRequired?: number;
}

// Read an LDK Option_u32Z into a plain number | undefined.
function optU32(o: Option_u32Z): number | undefined {
  return o instanceof Option_u32Z_Some ? o.some : undefined;
}

// Map one LDK ChannelDetails to a plain ChannelInfo. msat getters are bigint.
export function mapChannelDetails(cd: ChannelDetails): ChannelInfo {
  const info: ChannelInfo = {
    channelId: bytesToHex(cd.get_channel_id().get_a()),
    counterpartyNodeId: bytesToHex(cd.get_counterparty().get_node_id()),
    capacitySat: Number(cd.get_channel_value_satoshis()),
    outboundSendableSat: Number(cd.get_outbound_capacity_msat() / 1000n),
    inboundSat: Number(cd.get_inbound_capacity_msat() / 1000n),
    isUsable: cd.get_is_usable(),
    isChannelReady: cd.get_is_channel_ready(),
  };
  // Funding outpoint. LDK hands the txid little-endian (internal); convert to big-endian display for
  // explorers. A not-yet-funded channel yields an all-zero txid (or a null-ptr OutPoint wrapper whose
  // getters silently return zeros) — omit fundingTxid then.
  try {
    const outpoint = cd.get_funding_txo();
    const txidBytes = outpoint?.get_txid?.();
    if (txidBytes && txidBytes.some((b) => b !== 0)) {
      info.fundingTxid = ldkTxidToDisplay(txidBytes);
      info.fundingOutputIndex = outpoint.get_index();
    }
  } catch {
    /* channel not funded yet / null outpoint — leave fundingTxid unset */
  }
  // Funding confirmation progress (both Option_u32Z; present while a channel is still confirming).
  info.confirmations = optU32(cd.get_confirmations());
  info.confirmationsRequired = optU32(cd.get_confirmations_required());
  return info;
}

// Aggregate spendable/receivable over USABLE channels only.
export function sumBalance(channels: ChannelInfo[]): { spendableSat: number; receivableSat: number } {
  const usable = channels.filter((c) => c.isUsable);
  return {
    spendableSat: usable.reduce((s, c) => s + c.outboundSendableSat, 0),
    receivableSat: usable.reduce((s, c) => s + c.inboundSat, 0),
  };
}

// The `minimum_depth` we set as a channel fundee: confirmations to wait before an inbound
// CONFIRMED channel locks in. LDK enforces a lower bound of 1 (0-conf goes through the
// separate trusted-peer accept path, never global min_depth). Default 3.
export function resolveMinChannelConfirmations(v?: number): number {
  if (v == null || !Number.isFinite(v)) return 3;
  return Math.max(1, Math.floor(v));
}

// Whether to accept an inbound channel with 0 confirmations: only when the counterparty is
// allowlisted (trustedZeroConfPeers) AND the open actually requests zeroconf. Guards against
// 0-conf-accepting a normal open, which the peer rejects as "non-zero-conf ... min depth zero".
export function shouldZeroConfAccept(trusted: boolean, openerRequestsZeroConf: boolean): boolean {
  return trusted && openerRequestsZeroConf;
}

// Peer address book: pubkey (hex) -> its last-known {host, port}. Persisted so the node can
// redial its channel partners on start (LDK stores no peer addresses; a browser node forgets
// them on reload otherwise, stranding funded channels until a manual reconnect).
export type PeerAddress = { host: string; port: number };

// UI-facing view of force-close fund recovery (see getSweepStatus). Interfaces can't be
// declared inside a class, so this lives at module scope.
export interface SweepStatus {
  needsAddress: boolean;
  pendingCount: number;
  pendingSat: number;
  lastSweep?: { txid: string; sat: number; at: number };
}

// Storage key for the persisted peer address book. Non-critical cache (re-discoverable), so it's
// deliberately NOT part of the backup key set — a restore simply relearns addresses on reconnect.
const PEER_ADDRESS_BOOK_KEY = "peer_addresses";

// Per-channel high-water of ChannelMonitor.get_latest_update_id(). Non-critical (re-derivable,
// NOT in the encrypted backup): drives the channel-state regression guard. See state-highwater.ts.
const MONITOR_HIGHWATER_KEY = "monitor_update_highwater";

// Signed force-close sweep txs awaiting a successful broadcast. Non-critical (NOT in the backup):
// a JSON array of tx-hex, so a transient broadcast failure or a restart can't strand recoverable
// funds — retried on every sync tick until the node accepts each one. See broadcastPendingSweeps.
const SWEEP_PENDING_KEY = "sweep_pending_txs";

export const SWEEP_LAST_KEY = "sweep_last"; // non-critical: last completed force-close sweep (display only)

/** Safely parse the stored address-book JSON, dropping any malformed entries. Never throws. */
export function parsePeerAddressBook(raw: string | null | undefined): Record<string, PeerAddress> {
  if (!raw) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, PeerAddress> = {};
  for (const [k, v] of Object.entries(obj as Record<string, any>)) {
    if (v && typeof v.host === "string" && v.host && Number.isInteger(v.port)) {
      out[k] = { host: v.host, port: v.port };
    }
  }
  return out;
}

/**
 * Given the pubkeys of our channel counterparties and the address book, produce the deduped
 * list of peers to redial (only those we have a valid address for). Pure so the start-time
 * reconnection decision is unit-testable without LDK/WASM.
 */
export function channelPeersToRedial(
  counterpartyPubkeys: string[],
  book: Record<string, PeerAddress>
): Array<{ pubkey: string; host: string; port: number }> {
  const seen = new Set<string>();
  const out: Array<{ pubkey: string; host: string; port: number }> = [];
  for (const pk of counterpartyPubkeys) {
    if (seen.has(pk)) continue;
    seen.add(pk);
    const addr = book[pk];
    if (addr && addr.host && Number.isInteger(addr.port)) {
      out.push({ pubkey: pk, host: addr.host, port: addr.port });
    }
  }
  return out;
}

export class LibreListenerWallet {
  private config: WalletConfig;
  private logger?: Logger;
  private storage: SecureStorageProvider;
  private socketProvider: WebSocketStreamProvider;
  private isRunning: boolean = false;

  private wasmBinary?: Uint8Array;
  private wasmUrl?: string;

  private acquireRunLock?: () => Promise<(() => void) | null>;
  private releaseRunLock?: () => void;

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
  private chainSyncPromise?: Promise<void>;
  private nodeAnnTickCount = 0;
  private nodeAnnouncer?: NodeAnnouncer;
  // pubkey -> hadReadyChannel at last direct announce (see peersNeedingAnnouncement)
  private announceState = new Map<string, boolean>();
  private nextDescriptorId: number = 1;
  private stateVersion: number = 0;
  private monitorHighwater: Highwater = new Map();
  // Memoized funding-outpoint ("txidHex:index") → channelId for recordDurableHighwater.
  private monitorChannelIds: Map<string, string> = new Map();
  private stateListeners: (() => void)[] = [];
  private connectedPeers: Map<string, WebSocketDescriptor> = new Map(); // hex pubkey -> descriptor
  // Peers we want to keep connected (hex pubkey -> address). Drives auto-reconnect.
  private desiredPeers: Map<string, { host: string; port: number }> = new Map();
  // In-flight outbound dials (hex pubkey -> the dial promise). Coalesces concurrent
  // connectPeer() calls to the same peer so a race can't open a duplicate connection.
  private pendingDials: Map<string, Promise<void>> = new Map();
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  // Persisted pubkey -> {host,port} of peers we've connected to, so start() can redial our
  // channel partners across reloads (LDK keeps no peer addresses). Loaded on start.
  private peerAddressBook: Map<string, PeerAddress> = new Map();
  // scriptPubKey to sweep force-close outputs to (Event_SpendableOutputs). Set by the app.
  private sweepDestinationScript?: Uint8Array;
  // Signed sweep txs queued for (re)broadcast, keyed by tx-hex. Persisted under SWEEP_PENDING_KEY.
  private pendingSweeps: Map<string, Uint8Array> = new Map();
  // Whether we've already warned about claimable outputs with no sweep address — avoids
  // spamming the log every ~1s while the event replays. Reset when the destination changes.
  private sweepWarningShown = false;
  // Observability for the UI (SweepStatus) — display state only, never gates sweeping.
  private sweepNeedsAddress = false;
  private pendingSweepSats: Map<string, number> = new Map(); // txHex → best-effort sat value
  private lastSweep?: { txid: string; sat: number; at: number };
  private registryCache?: LspProvider[];
  private eventListeners: ((event: Event) => void)[] = [];
  // The SDK's own payment-log demux listener. Registered ONCE (a stop→start cycle must not
  // stack a duplicate handler each time — each duplicate re-runs every LDK event).
  private paymentLogListener?: (event: Event) => void;
  public nwc: NwcManager;
  // Forward-only payment history (source of truth for getPayments + NWC list_transactions).
  private paymentLog: PaymentLogger;
  // Forward-only channel-close history (source of truth for getChannelCloses).
  private closeLog: CloseLogger;

  // In-flight payBolt11 settlement waiters, resolved/rejected by the SAME payment-log demux
  // listener (never a second LDK event listener — a duplicate would double-process every
  // payment). Keyed by payment-hash hex; entries are removed on settle/fail/timeout.
  private settlementWaiters = new Map<
    string,
    { resolve: (preimageHex: string) => void; reject: (e: Error) => void }
  >();
  // Optional VSS durable-replica mirror (built in start() only when config.vssUrl is set). Best-effort
  // off-device backup of the encrypted state envelope; never gates LDK. See vss-mirror.ts.
  private vssMirror?: VssMirror;
  // Optional cross-device single-instance lease (built in start() when config.vssUrl is set and
  // enforceSingleDevice !== false). Refuses to start if another device holds a live lease. See vss-device-lease.ts.
  private vssLease?: VssDeviceLease;

  constructor(options: {
    config: WalletConfig;
    storage: SecureStorageProvider;
    socketProvider: WebSocketStreamProvider;
    logger?: Logger;
    wasmBinary?: Uint8Array;
    wasmUrl?: string;
    // Injected per-origin single-node lock acquirer. Returns a release fn, or null if another context
    // holds the lock (→ start() throws NodeAlreadyRunningError). Omitted on platforms without Web Locks.
    acquireRunLock?: () => Promise<(() => void) | null>;
  }) {
    this.config = options.config;
    this.storage = options.storage;
    this.socketProvider = options.socketProvider;
    this.logger = options.logger;
    this.wasmBinary = options.wasmBinary;
    this.wasmUrl = options.wasmUrl;
    this.acquireRunLock = options.acquireRunLock;
    this.nwc = new NwcManager(this, { logger: this.logger, storage: this.storage, network: this.config.network });
    // onChange pushes a live UI refresh on every payment-history mutation (e.g. a freshly-noted
    // NWC pending boost) — a display-only signal, so it notifies subscribers WITHOUT bumping the
    // fund-critical state_version or scheduling a VSS mirror.
    this.paymentLog = new PaymentLogger({
      storage: this.storage,
      logger: this.logger,
      onChange: () => this.notifyStateListeners(),
    });
    this.closeLog = new CloseLogger({ storage: this.storage, logger: this.logger });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger?.warn("Wallet is already running");
      return;
    }
    // Single-node lock: one LDK node per origin. Acquire BEFORE any storage access so two contexts
    // never open the same DB. Held for the node's lifetime; released on stop()/failure.
    if (this.acquireRunLock && !this.releaseRunLock) {
      const release = await this.acquireRunLock();
      if (!release) throw new NodeAlreadyRunningError();
      this.releaseRunLock = release;
    }
    try {
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
    this.storageCache = new StorageCache(this.storage, this.logger);
    await this.storageCache.load();

    const storedVersion = await this.storage.getItem("state_version");
    this.stateVersion = storedVersion ? parseInt(storedVersion, 10) || 0 : 0;

    const kvStore = KVStore.new_impl(this.storageCache);

    // 3. Setup key derivation & PhantomKeysManager
    let seedHex = await this.storage.getItem("ldk_seed");
    const seedExistedInStorage = seedHex !== null;
    let seed: Uint8Array;
    if (!seedHex) {
      seed = getSecureRandomBytes(32);
      seedHex = bytesToHex(seed);
      await this.storage.setItem("ldk_seed", seedHex);
    } else {
      // Fail loudly on a corrupt seed rather than silently deriving a different node identity.
      seed = parseSeedHex(seedHex);
    }

    // One VSS store id + client per start (opt-in via config.vssUrl), shared by the three VSS
    // consumers below — re-hydrate (3b), device lease (3c), and the mirror — so the store
    // derivation and client config can never drift between them.
    let vssClient: VssClient | undefined;
    let vssStoreId: string | undefined;
    if (this.config.vssUrl) {
      vssStoreId = await deriveVssStoreId(seedHex);
      vssClient = new VssClient({ baseUrl: this.config.vssUrl, storeId: vssStoreId, logger: this.logger });
    }

    // 3b. VSS durable-replica re-hydration (opt-in via config.vssUrl). If this origin has the seed
    // but NO channel_manager — local storage was lost/reaped, or the user did a seed-only restore —
    // pull the encrypted state envelope from VSS and restore it BEFORE loading the manager. This
    // turns the classic "seed without channel state → fresh empty node → force-close" trap into an
    // auto-recovery. Guarded to only run when the seed already existed (never a brand-new wallet)
    // and channel_manager is absent (NEVER overwrites existing local channel state). Best-effort:
    // any failure (network, wrong-network envelope, decrypt) falls through to the normal path, where
    // the readiness/regression guards still apply.
    if (vssClient && seedExistedInStorage) {
      const restored = await this.maybeRestoreStateFromVss(vssClient, seedHex);
      if (restored) {
        // reload() (NOT load(), which no-ops once loaded) so the cache actually picks up the
        // channel_manager + monitor keys importState just wrote straight to storage — otherwise
        // the monitors never load and the restored manager fails to decode → force-close.
        await this.storageCache.reload();
        const v = await this.storage.getItem("state_version");
        this.stateVersion = v ? parseInt(v, 10) || 0 : 0;
      }
    }

    // 3c. Cross-device single-instance lease (opt-in via config.vssUrl; on by default, disable with
    // enforceSingleDevice:false). The Web-Locks node lock only covers ONE origin — it can't see the
    // same wallet running on another device. Claim a time-boxed lease in the shared VSS store BEFORE
    // dialing any peer; if another device holds a live lease, throw CrossDeviceLockError so we never
    // put a second node on the same channel (→ force-close). VSS unreachable → start with a warning.
    if (vssClient && this.config.enforceSingleDevice !== false) {
      const ownerId = bytesToHex(getSecureRandomBytes(16));
      const lease = new VssDeviceLease(vssClient, ownerId, { logger: this.logger });
      await lease.acquire(); // throws CrossDeviceLockError if another device holds a live lease
      // Assign only AFTER acquire returns (didn't throw): a BLOCKED start must not later release/
      // delete the OTHER device's lease during teardown. A degraded (VSS-down) acquire still returns,
      // so we keep the object to attempt release + let the heartbeat claim the lease once VSS is back.
      this.vssLease = lease;
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
    // Layer C: wrap the persister so LDK only advances channel state after the write is durable.
    // getChainMonitor is late-bound — the ChainMonitor is constructed with this persister below.
    const monitorPersister = createDurablePersist(
      this.monitorUpdatingPersister.as_Persist(),
      () => this.storageCache!.flush(),
      () => this.chainMonitor,
      this.logger,
      // Advance the Layer-A high-water in step with durable persistence (never ahead of it),
      // covering channels opened mid-session too. See recordDurableHighwater.
      (txidLe, index, updateId) => {
        this.recordDurableHighwater(txidLe, index, updateId);
        // A durable monitor update just completed → LDK un-pauses the channel and may have queued
        // the next commitment-dance messages. Flush them NOW rather than waiting up to the 10s peer
        // tick: without this, each monitor-gated dance step adds ~10s, so an NWC keysend takes 15-30s
        // to settle — which throttles streaming-sats throughput to ~2/min. Safe to call here: this
        // runs in the durable flush's promise continuation, NOT inside an LDK SocketDescriptor
        // callback (the re-entrancy trap), so PeerManager access can't re-enter.
        try {
          this.peerManager?.process_events();
        } catch (e) {
          this.logger?.error(`[DurablePersist] process_events pump failed: ${e instanceof Error ? e.message : e}`);
        }
      },
      // The OutdatedChannelManager fix: enqueue a channel_manager snapshot into the SAME durable
      // batch as every monitor update, so a page kill can never leave disk with monitor N +
      // manager N-k (which LDK resolves by force-closing the channel on next load — reproduced
      // live 2026-07-09). Throws on failure so the ack is withheld and the channel stays paused.
      // Runs in the flush promise chain, never inside an LDK callback (where ChannelManager.write()
      // would re-enter LDK's locks).
      () => this.writeChannelManagerForDurableBatch(),
    );

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

    // Channel-state regression guard (Layer A). Refuse to start if any loaded monitor is BEHIND a
    // point this wallet durably reached — reconnecting stale channel state makes the peer force-close
    // it (2026-07-06 mainnet incident). Halting sends the user to restore-from-backup instead. Runs
    // BEFORE PeerManager/redial setup, so a regressed node never dials or reestablishes.
    const storedHighwater = parseHighwater(await this.storage.getItem(MONITOR_HIGHWATER_KEY));
    const summaries = channelMonitors.map((m) => ({
      channelId: bytesToHex(m.channel_id().get_a()),
      latestUpdateId: m.get_latest_update_id(),
    }));
    const regression = findRegression(summaries, storedHighwater);
    if (regression) {
      this.logger?.error(
        `[Guard] Channel-state regression on ${regression.channelId}: loaded update ${regression.loaded} < high-water ${regression.highwater}. Refusing to start.`,
      );
      throw new ChannelStateRegressionError(regression);
    }
    this.monitorHighwater = mergeHighwater(storedHighwater, summaries);
    this.storage
      .setItem(MONITOR_HIGHWATER_KEY, serializeHighwater(this.monitorHighwater))
      .catch((e) => this.logger?.error(`Failed to persist ${MONITOR_HIGHWATER_KEY}: ${e instanceof Error ? e.message : e}`));

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

    // 10. Load or construct ChannelManager. The handshake policy (minimum_depth, announce,
    // full-capacity inbound HTLCs, JIT underpaying-htlc acceptance) lives in buildUserConfig so it's
    // unit-testable against the real bindings — see user-config.ts.
    const userConfig = buildUserConfig({
      // Confirmations we wait for as the fundee of an inbound CONFIRMED channel (LDK's default is 6).
      // A trusted-peer 0-conf open bypasses this via accept_inbound_channel_from_trusted_peer_0conf.
      minimumDepth: resolveMinChannelConfirmations(this.config.minChannelConfirmations),
      // Announced (public) channels must match the counterparty's preference. Default private.
      announceChannels: this.config.announceChannels ?? false,
    });

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
        // A stored channel_manager that fails to decode is corrupt/mismatched
        // state, NOT a fresh wallet. Bootstrapping an empty ChannelManager here
        // would connect the peer, answer its channel_reestablish with "unknown
        // channel", and FORCE-CLOSE the real channel (the documented mainnet
        // incident). Refuse to start instead — the funds are recoverable via
        // restore-from-backup or the force-close sweeper, never by overwriting.
        const errMsg =
          "Stored channel_manager failed to decode (corrupt or key-mismatched state). " +
          "Refusing to start to avoid force-closing live channels — restore from a backup instead.";
        this.logger?.error(errMsg);
        throw new Error(errMsg);
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
    // Direct-to-peer alias delivery: LDK's broadcast_node_announcement never reaches a peer
    // that didn't request a gossip sync (lnd doesn't, from us), so when an alias is configured
    // we send our signed node_announcement through the custom-message slot instead.
    this.nodeAnnouncer = this.config.alias
      ? new NodeAnnouncer({
          alias: this.config.alias,
          getNodeSecret: () => this.keysManager!.get_node_secret_key(),
          logger: this.logger
            ? { info: (m) => this.logger!.info(m), error: (m) => this.logger!.error(m) }
            : undefined,
        })
      : undefined;
    this.peerManager = PeerManager.constructor_new(
      this.channelManager.as_ChannelMessageHandler(),
      ignoringHandler.as_RoutingMessageHandler(),
      ignoringHandler.as_OnionMessageHandler(),
      this.nodeAnnouncer
        ? this.nodeAnnouncer.buildHandler()
        : ignoringHandler.as_CustomMessageHandler(),
      Math.floor(Date.now() / 1000),
      getSecureRandomBytes(32),
      this.ldkLogger,
      this.keysManager.as_NodeSigner()
    );

    // 12. Initial sync with Esplora
    await this.runChainSync();

    // Recover any force-close sweep that didn't finish broadcasting before a prior shutdown, and
    // attempt it now; the sync tick below keeps retrying until the node accepts it.
    await this.loadPendingSweeps();
    void this.broadcastPendingSweeps();

    // 13. Setup background loops
    this.syncIntervalId = setInterval(() => {
      if (this.channelManager && this.chainMonitor) {
        this.runChainSync().catch(err => {
          this.logger?.error(`Background sync error: ${err.message}`);
        });
        void this.broadcastPendingSweeps();
      }
    }, 30000);

    this.peerTickIntervalId = setInterval(() => {
      if (this.peerManager) {
        this.peerManager.timer_tick_occurred();
        // Direct alias delivery: announce to newly-seen peers, re-announce when a channel
        // first becomes ready (lnd discards announcements for nodes not yet in its graph —
        // its own private channel to us is what puts us there), and refresh everyone on the
        // 5-min cadence below. queueTo before process_events so this tick flushes it.
        if (this.nodeAnnouncer) {
          const refreshAll = ++this.nodeAnnTickCount % 30 === 0;
          if (refreshAll) this.announceState.clear();
          const connected = (this.peerManager.list_peers() ?? []).map((p) =>
            bytesToHex(p.get_counterparty_node_id())
          );
          const ready = new Set(
            this.getChannels()
              .filter((c) => c.isChannelReady)
              .map((c) => c.counterpartyNodeId)
          );
          const { peers, next } = peersNeedingAnnouncement(this.announceState, connected, ready);
          this.announceState = next;
          for (const p of peers) this.nodeAnnouncer.queueTo(p);
          // Keep the legacy gossip broadcast too — it reaches gossip-synced peers if a
          // channel is ever publicly announced.
          if (refreshAll) this.broadcastNodeAnnouncement();
        }
        this.peerManager.process_events();
      }
    }, 10000);

    const eventHandler = EventHandler.new_impl({
      handle_event: (event: Event) => {
        // Dispatch with `instanceof`, NOT `event.constructor.name`: the production
        // (Vite/esbuild) build minifies the LDK binding class names (e.g. to "Fzt"),
        // so a `name === "Event_..."` string check silently fails on the deployed PWA
        // and NO event handler runs — the node receives an OpenChannelRequest/payment
        // but never accepts/claims it. `instanceof` compares the imported class
        // reference, which survives minification. (Worked in `pnpm dev` because dev
        // isn't minified — a nasty prod-only trap.)
        const name = event.constructor.name;
        this.logger?.info(`[LDK Event] Received event: ${name}`);
        let replayEvent = false; // ask LDK to re-deliver this event if we couldn't fully handle it

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
          const purpose = event.purpose;
          this.storage.getItem(`preimage_${paymentHash}`).then((preimageHex) => {
            // The node may have stopped between the event and this async read;
            // snapshot the manager and bail if it's gone (LDK re-emits on restart).
            const mgr = this.channelManager;
            if (!mgr) {
              this.logger?.warn(`[LDK Event] Node stopped before claim for hash ${paymentHash}; will re-claim on restart.`);
              return;
            }
            if (preimageHex) {
              // Never log the preimage itself (key-isolation guardrail: no preimages in logs).
              this.logger?.info(`[LDK Event] Claiming payment for hash ${paymentHash}`);
              mgr.claim_funds(hexToBytes(preimageHex));
            } else {
              const preimageOpt = purpose.preimage();
              if (preimageOpt instanceof Option_ThirtyTwoBytesZ_Some) {
                this.logger?.info(`[LDK Event] Claiming payment for hash ${paymentHash} (preimage from purpose)`);
                mgr.claim_funds(preimageOpt.some);
              } else {
                this.logger?.warn(`[LDK Event] Preimage unknown for hash: ${paymentHash}`);
              }
            }
          }).catch((e) => {
            this.logger?.error(`[LDK Event] Failed to claim payment for hash ${paymentHash}: ${e instanceof Error ? e.message : e}`);
          });
        } else if (event instanceof Event_OpenChannelRequest) {
          const tempChanId = (event as any).temporary_channel_id;
          const counterparty = (event as any).counterparty_node_id;
          const counterpartyHex = bytesToHex(counterparty);
          // Only 0-conf when the opener actually requested a zeroconf channel type; 0-conf-accepting
          // a normal open makes the peer reject it ("non-zero-conf channel has min depth zero").
          const openerZeroConf = !!(event as any).channel_type?.supports_zero_conf?.();
          let res;
          if (shouldZeroConfAccept(this.isZeroConfTrusted(counterpartyHex), openerZeroConf)) {
            // Trusted LSP/peer opening a zeroconf channel: usable immediately.
            this.logger?.info("[LDK Event] OpenChannelRequest from a trusted peer (zeroconf requested); accepting 0-conf...");
            res = this.channelManager!.accept_inbound_channel_from_trusted_peer_0conf(tempChanId, counterparty, 0n);
            if (!res.is_ok()) {
              this.logger?.info("[LDK Event] Zero-conf unavailable; accepting as a normal channel (awaits confirmation).");
              res = this.channelManager!.accept_inbound_channel(tempChanId, counterparty, 0n);
            }
          } else {
            // Untrusted peer, or a normal (non-zeroconf) open: accept a confirmation-gated
            // channel — still works, just not instant (double-spend guardrail).
            this.logger?.info("[LDK Event] OpenChannelRequest; accepting as a normal confirmed channel (no 0-conf).");
            res = this.channelManager!.accept_inbound_channel(tempChanId, counterparty, 0n);
          }
          this.logger?.info(`[LDK Event] accept_inbound_channel result: ${res.is_ok()}`);
        } else if (event instanceof Event_PendingHTLCsForwardable) {
          this.logger?.info("[LDK Event] PendingHTLCsForwardable received. Processing forwards...");
          this.channelManager!.process_pending_htlc_forwards();
        } else if (event instanceof Event_ChannelPending) {
          this.logger?.info(`[LDK Event] Channel pending!`);
        } else if (event instanceof Event_ChannelReady) {
          this.logger?.info(`[LDK Event] Channel ready!`);
          this.broadcastNodeAnnouncement();
        } else if (event instanceof Event_PaymentClaimed) {
          this.logger?.info(`[LDK Event] Payment claimed!`);
        } else if (event instanceof Event_ChannelClosed) {
          const channelId = bytesToHex(event.channel_id.get_a());
          const counterparty =
            event.counterparty_node_id && event.counterparty_node_id.length === 33 && event.counterparty_node_id.some((b) => b !== 0)
              ? bytesToHex(event.counterparty_node_id)
              : undefined;
          const capacitySat =
            event.channel_capacity_sats instanceof Option_u64Z_Some ? Number(event.channel_capacity_sats.some) : undefined;
          const reason = closureReasonLabel(event.reason);
          this.logger?.info(`[LDK Event] ChannelClosed ${channelId} (${reason})`);
          this.closeLog.record({ channelId, counterpartyNodeId: counterparty, capacitySat, reason, closedAt: Date.now() });
          this.notifyStateChanged();
        } else if (event instanceof Event_SpendableOutputs) {
          // A channel close left on-chain outputs we can claim. Sweep them to the
          // configured address. Done synchronously here so the descriptors are used
          // before the event is freed; only the resulting tx bytes are broadcast async.
          // If we can't sweep yet (no address set / build failed), ask LDK to REPLAY the
          // event so it retries once an address is set — funds aren't dropped.
          if (!this.handleSpendableOutputs((event as any).outputs)) replayEvent = true;
        }

        return replayEvent
          ? Result_NoneReplayEventZ.constructor_err(ReplayEvent.constructor_new())
          : Result_NoneReplayEventZ.constructor_ok();
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

    // Keep the cross-device lease fresh while we run (best-effort; a VSS blip never kills the session).
    this.vssLease?.startHeartbeat();

    // VSS durable-replica mirror — opt-in via config.vssUrl (unset = disabled, no behavior change).
    // Best-effort off-device backup of the encrypted state envelope after each state change; it
    // NEVER gates the node. Design A: a blind write of the same slim, seed-encrypted envelope the
    // Drive backup already produces, so the server only sees ciphertext (key-isolation guardrail).
    if (vssClient) {
      try {
        this.vssMirror = new VssMirror(vssClient, () => this.exportState(), { logger: this.logger });
        void this.vssMirror.flush(); // seed VSS with current state without waiting for a change
        this.logger?.info(`[VSS] Durable-replica mirror enabled (store ${vssStoreId!.slice(0, 8)}…)`);
      } catch (e) {
        // Never let VSS setup break startup.
        this.logger?.warn(`[VSS] Mirror setup failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

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

    // Reconnect to the peers we hold channels with (keeps funded channels alive across reloads).
    // Fire-and-forget so a slow dial never blocks startup.
    void this.redialChannelPeers();

    // Load the forward-only payment history and attach a listener that records payment
    // outcomes. Thin LDK `instanceof` demux here (minification-safe, per the event-dispatch
    // gotcha) → plain PaymentLogger calls; the testable logic lives in payment-log.ts.
    await this.paymentLog.load();
    await this.closeLog.load();
    // Register the demux listener only once for this wallet instance — re-registering on every
    // start() would stack duplicates (N restarts → N redundant recordSent/recordReceived writes
    // per event). The closure only touches this.paymentLog (which persists across stop/start).
    if (!this.paymentLogListener) {
      this.paymentLogListener = (event: Event) => {
        try {
          if (event instanceof Event_PaymentSent) {
            const feeMsat = event.fee_paid_msat instanceof Option_u64Z_Some ? Number(event.fee_paid_msat.some) : 0;
            const sentHashHex = bytesToHex(event.payment_hash);
            const preimageHex = bytesToHex(event.payment_preimage);
            this.paymentLog.recordSent(sentHashHex, feeMsat / 1000, preimageHex);
            this.settlementWaiters.get(sentHashHex)?.resolve(preimageHex);
          } else if (event instanceof Event_PaymentFailed) {
            if (event.payment_hash instanceof Option_ThirtyTwoBytesZ_Some) {
              const failedHashHex = bytesToHex(event.payment_hash.some);
              this.paymentLog.recordFailed(failedHashHex);
              this.settlementWaiters.get(failedHashHex)?.reject(new Error("Payment failed"));
            }
          } else if (event instanceof Event_PaymentClaimed) {
            this.paymentLog.recordReceived(bytesToHex(event.payment_hash), Number(event.amount_msat) / 1000);
          }
        } catch (e) {
          this.logger?.error(`[PaymentLog] event handling failed: ${e instanceof Error ? e.message : e}`);
        }
      };
      this.addEventListener(this.paymentLogListener);
    }

    // Initialize and start Nostr Wallet Connect listeners
    await this.nwc.init();
    await this.nwc.start();
    } catch (e) {
      // A failed start that already flipped isRunning / armed the background loops must tear
      // them ALL down before freeing the lock (see teardownRuntime). persist: false — a
      // half-started node's state must not be written out.
      try {
        await this.teardownRuntime({ persist: false });
      } finally {
        // Now free the lock so a retry / fresh instance in this context can start cleanly.
        this.releaseRunLock?.();
        this.releaseRunLock = undefined;
      }
      throw e;
    }
  }

  /**
   * Fetch a Rapid Gossip Sync snapshot from `rapidGossipSyncUrl` and apply it to the
   * NetworkGraph so the router can find multi-hop routes. Incremental: tracks the last
   * sync timestamp under the `rgs_timestamp` storage key. Safe to call repeatedly.
   */
  /**
   * Run an Esplora chain sync, coalescing concurrent calls into one in-flight run (mirrors
   * syncGossip). LDK's Confirm interface must see `best_block_updated`/`transactions_confirmed`
   * in chain order; two overlapping `EsploraSyncClient.sync()` runs — the 30s interval firing
   * while a slow, rate-limited sync is still walking blocks — otherwise interleave and can
   * REGRESS the best block (a slow run finishing after a fast one advanced past it) and
   * mis-order confirmations, flip-flopping a pending channel's confirmation count.
   */
  private runChainSync(): Promise<void> {
    if (this.chainSyncPromise) return this.chainSyncPromise;
    if (!this.channelManager || !this.chainMonitor || !this.syncClient) return Promise.resolve();
    const cm = this.channelManager;
    const chm = this.chainMonitor;
    this.chainSyncPromise = this.syncClient
      .sync(cm, chm)
      .finally(() => {
        this.chainSyncPromise = undefined;
      });
    return this.chainSyncPromise;
  }

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
    // The fetch timestamp comes from the GRAPH ITSELF (LDK serializes its last-RGS timestamp
    // inside the graph blob), never a separate storage key. The graph historically persisted
    // only on a clean stop() — which a tab close/reload never calls — so a reload loaded a
    // FRESH graph while the old standalone rgs_timestamp key survived: the sync then applied a
    // delta to emptiness and the router saw "0 nodes and 0 channels" (every multi-hop boost
    // failed RouteNotFound; hit live on mainnet 2026-07-09). Deriving from the graph makes the
    // split-brain impossible, and an empty graph always fetches the FULL snapshot (/0).
    const tsOpt = this.networkGraph.get_last_rapid_gossip_sync_timestamp();
    let lastTs = tsOpt instanceof Option_u32Z_Some ? tsOpt.some : 0;
    const roPre = this.networkGraph.read_only();
    const preChannels = roPre.list_channels().length;
    roPre.free(); // ReadOnlyNetworkGraph holds a read lock that must be freed.
    if (preChannels === 0) lastTs = 0;
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
    const readOnly = this.networkGraph.read_only();
    const channelCount = readOnly.list_channels().length;
    readOnly.free(); // ReadOnlyNetworkGraph holds a read lock that must be freed.
    this.logger?.info(`[RGS] Gossip synced (ts=${newTs}); graph now has ${channelCount} channels.`);
    // Persist the graph NOW, not only on stop() (which a tab close/reload never calls) — so the
    // next load starts from this graph + its embedded timestamp and fetches only a delta instead
    // of routing against an empty graph until the next full sync. Best-effort: a failed write
    // just means the next start re-downloads the full snapshot.
    try {
      await this.storage.setItem("network_graph", bytesToHex(this.networkGraph.write()));
    } catch (err) {
      this.logger?.error(`[RGS] Failed to persist network graph: ${err instanceof Error ? err.message : err}`);
    }
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
    this.notifyStateListeners();
    // Mirror the new state to VSS (debounced, best-effort; no-op unless config.vssUrl is set).
    this.vssMirror?.schedule();
  }

  // Fire the onStateChanged subscribers only — a lightweight UI-refresh signal WITHOUT bumping the
  // fund-critical state_version or scheduling a VSS mirror. Used for display-only changes such as a
  // payment-history mutation (a noted-pending NWC boost), which must reach the transaction list live
  // but does not change channel state.
  private notifyStateListeners(): void {
    for (const l of this.stateListeners) {
      try {
        l();
      } catch (e) {
        this.logger?.error(`onStateChanged listener error: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /**
   * Advance the persisted per-channel high-water AFTER a monitor update durably persisted
   * (driven by createDurablePersist's onDurablePersisted hook). Keying by the funding outpoint
   * → channelId via list_monitors(), it covers every channel — including ones opened mid-session
   * — and, crucially, only ever moves the mark to a durably-committed update id, so the mark can
   * never sit AHEAD of on-disk state (which would false-trigger the regression halt on the next
   * load). Monotonic + best-effort. Replaces the old tick-driven advance off live (possibly
   * not-yet-durable) in-memory monitors.
   */
  private recordDurableHighwater(txidLe: Uint8Array, index: number, updateId: bigint): void {
    if (!this.chainMonitor) return;
    let channelId: string | undefined;
    try {
      channelId = this.lookupMonitorChannelId(bytesToHex(txidLe), index);
    } catch (e) {
      this.logger?.error(`[Highwater] list_monitors lookup failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (!channelId) return; // channel closed/removed between persist and ack — nothing to track
    // In-place monotonic advance (mergeHighwater's semantics for a single channel, without the
    // per-ack full-Map copy + deep-equals — this runs in the durable-ack hot path, ~2-3× per payment).
    const cur = this.monitorHighwater.get(channelId);
    if (cur !== undefined && updateId <= cur) return;
    this.monitorHighwater.set(channelId, updateId);
    this.storage
      .setItem(MONITOR_HIGHWATER_KEY, serializeHighwater(this.monitorHighwater))
      .catch((e) => this.logger?.error(`Failed to persist ${MONITOR_HIGHWATER_KEY}: ${e instanceof Error ? e.message : e}`));
  }

  /**
   * Funding-outpoint → channelId, memoized. The monitor set only changes on channel open/close,
   * so scanning list_monitors() (a WASM vector materialization) on every durable ack is wasted
   * work; a miss re-scans, and the cache is cleared on teardown. A stale entry for a closed
   * channel is benign: findRegression ignores a mark that has no loaded monitor.
   */
  private lookupMonitorChannelId(txidHex: string, index: number): string | undefined {
    const key = `${txidHex}:${index}`;
    const cached = this.monitorChannelIds.get(key);
    if (cached) return cached;
    for (const tuple of this.chainMonitor!.list_monitors()) {
      const outpoint = tuple.get_a();
      if (outpoint.get_index() === index && bytesToHex(outpoint.get_txid()) === txidHex) {
        const channelId = bytesToHex(tuple.get_b().get_a());
        this.monitorChannelIds.set(key, channelId);
        return channelId;
      }
    }
    return undefined;
  }

  /**
   * Create a BOLT11 invoice to receive a payment (sats). Returns the invoice string.
   */
  async createInvoice(amountSats: number, description = "Libre Listener Wallet", expirySeconds?: number): Promise<string> {
    const { invoice } = await this.buildInvoice(BigInt(Math.round(amountSats)) * 1000n, description, resolveInvoiceExpiry(expirySeconds));
    this.logger?.info(`[Receive] Created BOLT11 invoice for ${amountSats} sats`);
    return invoice;
  }

  // Snapshot list_channels() into the pure HintableChannel shape (see hint-selection.ts).
  private hintableChannels(): HintableChannel[] {
    if (!this.channelManager) return [];
    return this.channelManager.list_channels().map((ch: ChannelDetails) => {
      const scidOpt = ch.get_inbound_payment_scid();
      const shortOpt = ch.get_short_channel_id();
      const fwd = ch.get_counterparty().get_forwarding_info();
      return {
        isUsable: ch.get_is_usable(),
        counterpartyNodeId: bytesToHex(ch.get_counterparty().get_node_id()),
        inboundPaymentScid: scidOpt instanceof Option_u64Z_Some ? scidOpt.some : undefined,
        shortChannelId: shortOpt instanceof Option_u64Z_Some ? shortOpt.some : undefined,
        inboundCapacityMsat: ch.get_inbound_capacity_msat(),
        // See forwardingInfoFromLdk's doc comment: get_forwarding_info() always returns a
        // truthy wrapper, even for LDK's None, so `fwd ? ... : undefined` alone is not safe.
        forwardingInfo: forwardingInfoFromLdk(fwd),
      };
    });
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
    preimage?: Uint8Array,
    // LSPS2 JIT: a forced intercept hint (the LSP's jit_channel_scid) the invoice MUST advertise
    // so an external payer routes through the LSP and triggers its HTLC interceptor. Prioritized
    // ahead of any capacity-ranked channel hints.
    priorityHint?: HintHop
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

    // LDK refuses route hints when ANY public channel exists, which strands an unannounced
    // leaf node (nothing can route to it from gossip alone — proven live: external payers all
    // "no route"). Ensure a last-hop hint: append + re-sign via the pure transformer. Hints on
    // public channels are legal BOLT11. Best-effort: a transformer failure logs and falls back
    // to the original (a direct peer can still pay it) — never fail invoice creation over it.
    let finalInvoice = invoice;
    try {
      if (priorityHint) {
        // JIT invoice: force the LSP's intercept scid in FIRST (prioritized over capacity-ranked
        // hints), regardless of whether LDK already added its own — an external payer must route
        // via the intercept scid so the LSP's HTLC interceptor fires and skims the opening fee.
        const hints = prioritizeHints(priorityHint, this.hintableChannels());
        if (hints.length && this.keysManager) {
          finalInvoice = appendRouteHints(invoice, hints, this.keysManager.get_node_secret_key());
          this.logger?.info(`[Invoice] Appended intercept + ${hints.length - 1} channel hint(s) for JIT`);
        }
      } else if (!hasRouteHint(invoice)) {
        const hints = selectHintChannels(this.hintableChannels());
        if (hints.length && this.keysManager) {
          finalInvoice = appendRouteHints(invoice, hints, this.keysManager.get_node_secret_key());
          this.logger?.info(`[Invoice] Appended ${hints.length} route hint(s) (LDK omitted hints)`);
        }
      }
    } catch (e) {
      this.logger?.warn(`[Invoice] Route-hint append failed; returning unhinted invoice: ${(e as Error)?.message ?? e}`);
      finalInvoice = invoice;
    }

    await this.storage.setItem(`preimage_${paymentHashHex}`, bytesToHex(pre));
    return { invoice: finalInvoice, paymentHash: paymentHashHex, preimage: bytesToHex(pre) };
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

  // The durable-batch manager write (see createDurablePersist's persistManager): serialize the
  // channel_manager and enqueue it so it commits WITH the monitor update it belongs to. Unlike
  // persistChannelManagerState this THROWS on failure — the durable ack must be withheld when the
  // manager can't land (an acked batch missing the manager is exactly the OutdatedChannelManager
  // force-close on next load). A missing manager (teardown race) is a no-op, not an error.
  private async writeChannelManagerForDurableBatch(): Promise<void> {
    if (!this.channelManager) return;
    await this.storage.setItem("channel_manager", bytesToHex(this.channelManager.write()));
  }

  // Flush ONLY the channel manager — the irreplaceable, backed-up state. Used before an export so
  // the backup is current without re-serializing the ~20MB network graph (which isn't backed up).
  private async persistChannelManagerState(): Promise<void> {
    if (this.channelManager) {
      try {
        await this.storage.setItem("channel_manager", bytesToHex(this.channelManager.write()));
      } catch (err) {
        this.logger?.error(`Failed to save channel manager: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Tear down every runtime resource start() arms — the VSS mirror/lease, NWC listeners, the 4
   * background loops, reconnect timers, peer sockets — and null the LDK pointers. The ONE teardown
   * path, shared by stop() and start()'s failure handler, so a resource added to start() can never
   * leak on just one of them (a leaked loop keeps persisting channel state and dialing peers after
   * the run lock frees — letting a second context start a SECOND node over the same IndexedDB, the
   * dual-node race the single-node lock exists to prevent → stale-state force-close).
   *
   * `persist: true` (a clean stop()) additionally flushes the VSS mirror FIRST — uploading this
   * device's FINAL state while the channel manager is still alive, which is what makes a
   * cross-device handoff safe — and persists the channel manager. A failed start passes
   * `persist: false`: a half-started node's state must NOT be written out.
   */
  private async teardownRuntime(opts: { persist: boolean }): Promise<void> {
    if (this.vssMirror) {
      if (opts.persist) {
        await this.vssMirror.flush().catch((e) =>
          this.logger?.error(`[VSS] Final mirror flush on stop failed: ${e instanceof Error ? e.message : e}`)
        );
      }
      this.vssMirror.stop();
      this.vssMirror = undefined;
    }
    // Release the cross-device lease so another device can take over immediately (best-effort).
    // Only if WE acquired it (this.vssLease is set only after a non-blocked acquire) — a
    // CrossDeviceLockError leaves it undefined so we never delete the holder's lease.
    if (this.vssLease) { await this.vssLease.release().catch(() => {}); this.vssLease = undefined; }

    // Stop Nostr Wallet Connect listeners (log-and-continue: the rest of the teardown must run).
    try {
      await this.nwc.stop();
    } catch (e) {
      this.logger?.error(`NWC teardown failed: ${e instanceof Error ? e.message : e}`);
    }

    for (const id of [this.syncIntervalId, this.peerTickIntervalId, this.eventTickIntervalId, this.gossipIntervalId]) {
      if (id) clearInterval(id);
    }
    this.syncIntervalId = undefined;
    this.peerTickIntervalId = undefined;
    this.eventTickIntervalId = undefined;
    this.gossipIntervalId = undefined;

    // Drop any queued-but-unsent alias announcements and the per-peer announce state so a
    // restart re-announces from scratch.
    this.nodeAnnouncer?.clear();
    this.nodeAnnouncer = undefined;
    this.announceState.clear();

    // Stop auto-reconnect first: cancel pending redials and forget desired peers so the
    // disconnects below don't schedule new reconnect attempts.
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    this.desiredPeers.clear();

    // Disconnect peers
    for (const descriptor of this.connectedPeers.values()) {
      try { descriptor.disconnect_socket(); } catch { /* best-effort during teardown */ }
    }
    this.connectedPeers.clear();
    this.monitorChannelIds.clear();

    // Persist final states
    if (opts.persist) {
      await this.persistManagerState();
    }

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

  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger?.warn("Wallet is not running");
      return;
    }
    this.logger?.info("Stopping LDK Node...");

    const releaseRunLock = this.releaseRunLock;
    this.releaseRunLock = undefined;

    try {
      await this.teardownRuntime({ persist: true });
    } finally {
      releaseRunLock?.();
    }
  }

  async sync(): Promise<void> {
    if (!this.isRunning || !this.channelManager || !this.chainMonitor) {
      throw new Error("Wallet is not running");
    }
    await this.runChainSync();
  }

  status(): "Stopped" | "Running" {
    return this.isRunning ? "Running" : "Stopped";
  }

  getStateVersion(): number {
    return this.stateVersion;
  }

  async exportState(opts?: { passphrase?: string }): Promise<string> {
    // Flush the latest channel manager so the backup is current — but NOT the ~20MB network graph
    // (it isn't backed up; it re-syncs from RGS on restore), so exporting stays cheap.
    if (this.isRunning) {
      await this.persistChannelManagerState();
      // Drain any monitor writes still in-flight (Layer C keeps them InProgress until the
      // IndexedDB commit lands) BEFORE we read the monitor keys below — otherwise the backup can
      // capture a manager at update N+1 alongside a monitor still at N (a torn snapshot that
      // fails to restore / force-closes). storage.getItem reads the committed store, not the cache.
      if (this.storageCache) {
        await this.storageCache.flush().catch((e) =>
          this.logger?.error(`[Export] monitor flush before export failed: ${e instanceof Error ? e.message : e}`)
        );
      }
    }
    const seedHex = await this.storage.getItem("ldk_seed");
    if (!seedHex) {
      throw new Error("Cannot export: no wallet seed found in storage");
    }

    const entries: Record<string, string> = {};
    // Direct (non-KVStore) keys written by the wallet itself. Pinned in backup-keys.ts.
    const directKeys = BACKUP_DIRECT_KEYS;
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
    // Payment-history records (`tx_*`, one per payment). Additive + NOT fund-critical: these are
    // enumerated from storage (dynamic, unbounded keys — not a fixed BACKUP_DIRECT_KEY) so a
    // restore carries the transaction list onto a fresh device instead of starting the ledger
    // empty. Best-effort — a history-enumeration failure must never fail the fund-critical export
    // above; providers that can't enumerate keys (no `keys()`) simply back up no history. On
    // import the generic entry loop writes them back, and start()'s PaymentLogger rehydrates them.
    if (typeof this.storage.keys === "function") {
      try {
        for (const k of await this.storage.keys()) {
          if (!k.startsWith(TX_KEY_PREFIX)) continue;
          const v = await this.storage.getItem(k);
          if (v !== null) entries[k] = v;
        }
      } catch (e) {
        this.logger?.warn(`[Export] payment-history enumeration skipped (non-fatal): ${e instanceof Error ? e.message : e}`);
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
    // A restore is authoritative: drop any stale high-water FIRST (before any entry writes) so a
    // crash mid-restore can't leave a marker from a prior/other wallet that false-halts the
    // restored (possibly lower) monitors. The next start() re-initializes it from the restored
    // monitors.
    await this.storage.removeItem(MONITOR_HIGHWATER_KEY);
    // Write the seed LAST for crash-safety. If the browser is killed mid-restore
    // and ldk_seed lands first, storage holds a bare seed with no channel_manager
    // — the seed-without-state condition that force-closes on the next start.
    // Ordering seed last means a partial restore is an obviously-incomplete
    // wallet (no seed yet) rather than a dangerous half-restored one.
    const entries = Object.entries(payload.entries);
    for (const [k, v] of entries) {
      if (k === "ldk_seed") continue;
      await this.storage.setItem(k, v);
    }
    const seedEntry = payload.entries["ldk_seed"];
    if (seedEntry !== undefined) {
      await this.storage.setItem("ldk_seed", seedEntry);
    }
  }

  /**
   * Re-hydrate channel state from the VSS durable replica when THIS origin has the seed but NO local
   * channel_manager (lost/reaped storage, or a seed-only restore). Reuses importState (decrypts with
   * the seed, enforces network match, writes crash-safely, seed last). NEVER overwrites EXISTING
   * local channel state — copying newer VSS state over a device that already holds stale channel
   * state does NOT cleanly reconstruct the channel in LDK (the monitors don't replace over the old
   * ones → force-close on reestablish; see the cross-device-handoff soak). NEVER throws into start().
   * Returns true iff state was restored. Runs before the manager load, while stopped.
   *
   * SAFETY: importState clears the monitor high-water mark. We PRESERVE any retained mark across the
   * import so a VSS replica behind this device's proven progress still trips the Layer-A regression
   * halt on the manager load rather than silently reconnecting with stale state.
   */
  private async maybeRestoreStateFromVss(client: VssClient, seedHex: string): Promise<boolean> {
    try {
      // Only re-hydrate into EMPTY local storage. (Newer-VSS-over-stale-local is not safe to copy —
      // that's the cross-device active-handoff limitation; the safe pattern is one node + NWC clients.)
      if ((await this.storage.getItem("channel_manager")) !== null) return false;
      const obj = await client.getObject(VSS_STATE_BACKUP_KEY);
      if (!obj || obj.value.length === 0) return false; // nothing durable to restore
      const envelope = new TextDecoder().decode(obj.value);
      const retainedHighwater = await this.storage.getItem(MONITOR_HIGHWATER_KEY);
      await this.importState(envelope, seedHex); // network-checked + crash-safe; isRunning is false here
      if (retainedHighwater !== null) {
        await this.storage.setItem(MONITOR_HIGHWATER_KEY, retainedHighwater);
      }
      this.logger?.info("[VSS] Re-hydrated channel state from durable replica (local had none).");
      return true;
    } catch (e) {
      this.logger?.warn(`[VSS] Re-hydrate skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      return false;
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
    // The backup's monotonic `state_version` counter (0 if the envelope predates the key), so a
    // caller can detect "this backup is AHEAD of my local storage" before starting — the guard
    // against a device whose IndexedDB was evicted/rolled back to an older but self-consistent
    // snapshot (which the local channel-state-regression check can't see). Absent when ok:false.
    stateVersion?: number;
    error?: string;
  }> {
    // Delegates to the pure state-backup verifier so wallet-free callers (roaming boot) share it.
    return verifyBackupEnvelope(envelope, secret);
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

  getChannels(): ChannelInfo[] {
    if (!this.isRunning || !this.channelManager) return [];
    return this.channelManager.list_channels().map(mapChannelDetails);
  }

  // Forward-only payment history, newest first. Backs the app's transaction-history UI
  // and NWC `list_transactions`. Lazily loads from storage if start() hasn't run yet.
  async getPayments(): Promise<PaymentRecord[]> {
    if (!this.paymentLog.isLoaded()) await this.paymentLog.load();
    return this.paymentLog.getRecords();
  }

  // Channel-close history, newest first. Works with the node stopped (lazily loads).
  async getChannelCloses(): Promise<ChannelCloseRecord[]> {
    if (!this.closeLog.isLoaded()) await this.closeLog.load();
    return this.closeLog.getRecords();
  }

  // Register an outbound payment intent so it appears in history with its amount even
  // when initiated outside sendKeysendPayment (e.g. a BOLT11 send via NWC pay_invoice or
  // the extension's payBolt11). Finalized on Event_PaymentSent / Event_PaymentFailed.
  notePendingPayment(rec: PaymentRecord): void {
    this.paymentLog.notePending(rec);
  }

  // Finalize a noted-pending payment as failed. Needed for a PRE-SEND failure (e.g. RouteNotFound):
  // nothing left the node, so NO LDK event fires, and a record left pending would strand forever in
  // history (the "stuck PENDING" bug). The NWC pay_invoice path calls this on send_payment error.
  recordFailedPayment(paymentHashHex: string): void {
    this.paymentLog.recordFailed(paymentHashHex);
  }

  // Public wrapper so the NWC pay paths (which call send_payment directly, not payBolt11) can wait
  // out a peer-reconnect window before routing — the same pre-flight wait sendKeysendPayment/
  // payBolt11 use. Resolves true once a channel is usable (or already was), false on timeout.
  async waitForUsableChannel(): Promise<boolean> {
    return this.awaitUsableChannel();
  }

  getBalance(): { spendableSat: number; receivableSat: number } {
    return sumBalance(this.getChannels());
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
    // Union of our transport map and LDK's handshake-complete list: the map alone can lose a
    // live peer after LDK kills a duplicate connection (see connectPeer), and LDK's list alone
    // misses a socket still mid-handshake.
    const peers = new Set(this.connectedPeers.keys());
    try {
      for (const p of this.peerManager?.list_peers() ?? []) {
        peers.add(bytesToHex(p.get_counterparty_node_id()));
      }
    } catch {
      // bindings hiccup — fall back to the map alone
    }
    return Array.from(peers);
  }

  // LDK's own view of whether a (handshake-complete) connection to this peer exists — the
  // ground truth our descriptor map can drift from. NEVER call synchronously from inside an
  // LDK callback (see the handleDisconnect re-entrancy note): list_peers() borrows PeerManager
  // state and re-entrant use traps with BorrowMutError.
  private ldkHasPeer(pubkey: string): boolean {
    try {
      const peers = this.peerManager?.list_peers() ?? [];
      return peers.some((p) => bytesToHex(p.get_counterparty_node_id()) === pubkey);
    } catch {
      return false;
    }
  }

  /** UI-facing view of force-close fund recovery. Display only — never gates the sweep itself. */
  getSweepStatus(): SweepStatus {
    let pendingSat = 0;
    for (const v of this.pendingSweepSats.values()) pendingSat += v;
    return {
      needsAddress: this.sweepNeedsAddress,
      pendingCount: this.pendingSweeps.size,
      pendingSat,
      ...(this.lastSweep ? { lastSweep: this.lastSweep } : {}),
    };
  }

  /** Set the on-chain scriptPubKey to sweep force-closed funds to. Pass undefined to clear. */
  setSweepDestination(scriptPubKey?: Uint8Array): void {
    this.sweepDestinationScript = scriptPubKey && scriptPubKey.length > 0 ? scriptPubKey : undefined;
    this.sweepWarningShown = false; // a destination change is worth a fresh warning if still unset
    if (this.sweepDestinationScript && this.sweepNeedsAddress) {
      this.sweepNeedsAddress = false;
      this.notifyStateChanged();
    }
  }

  /**
   * Handle Event_SpendableOutputs: a channel close produced on-chain outputs we can claim.
   * Builds the sweep tx synchronously (the descriptors are only valid within the event), then
   * broadcasts the plain tx bytes async. No-op (with a warning) if no sweep address is set.
   */
  // Returns true if handled (swept or nothing to do), false if LDK should replay the event
  // later (e.g. no sweep address set yet, or the tx build failed) so funds aren't dropped.
  private handleSpendableOutputs(descriptors: any[]): boolean {
    if (!descriptors || descriptors.length === 0) return true;
    if (!this.sweepDestinationScript) {
      if (!this.sweepWarningShown) {
        this.logger?.warn(`[Sweep] ${descriptors.length} claimable output(s) from a channel close — set a sweep address to recover them (will retry).`);
        this.sweepWarningShown = true; // suppress the ~1s replay spam until the destination changes
      }
      if (!this.sweepNeedsAddress) {
        this.sweepNeedsAddress = true;
        this.notifyStateChanged(); // surface "set a recovery address" in the UI
      }
      return false;
    }
    if (!this.keysManager || !this.syncClient) {
      this.logger?.error("[Sweep] Wallet not running; cannot sweep spendable outputs.");
      return false;
    }
    let txBytes: Uint8Array;
    try {
      const feerate = this.syncClient.getFeeRate(ConfirmationTarget.LDKConfirmationTarget_OutputSpendingFee);
      const res = this.keysManager.as_OutputSpender().spend_spendable_outputs(
        descriptors,
        [], // sweep everything to the destination (no extra outputs)
        this.sweepDestinationScript,
        feerate,
        Option_u32Z.constructor_none(),
      );
      if (!res.is_ok()) {
        this.logger?.error(`[Sweep] spend_spendable_outputs failed: ${(res as any).err?.toString?.() ?? "unknown error"}`);
        return false;
      }
      txBytes = (res as any).res as Uint8Array;
    } catch (e: any) {
      this.logger?.error(`[Sweep] Failed to build sweep tx: ${e?.message ?? e}`);
      return false;
    }
    // Queue + persist the signed sweep, then attempt broadcast. Unlike the old fire-and-forget,
    // a transient broadcast failure (esplora 429 / offline) or a restart no longer strands the
    // funds: the tx is retried on every sync tick until the node accepts it. The event is safely
    // consumed (return true) because the recovery guarantee now lives in the persisted queue.
    const key = bytesToHex(txBytes);
    // Best-effort display value: sum the descriptors' output values (bigint sats).
    let outSat = 0;
    try {
      for (const d of descriptors) {
        const v = (d as any)?.output?.value;
        if (typeof v === "bigint") outSat += Number(v);
        else if (typeof v === "number") outSat += v;
      }
    } catch { /* display-only — never block the sweep */ }
    this.pendingSweepSats.set(key, outSat);
    this.pendingSweeps.set(key, txBytes);
    void this.persistPendingSweeps();
    void this.broadcastPendingSweeps();
    return true;
  }

  /** Persist the set of pending sweep txs (tx-hex array) so they survive a restart. */
  private async persistPendingSweeps(): Promise<void> {
    try {
      await this.storage.setItem(SWEEP_PENDING_KEY, JSON.stringify(Array.from(this.pendingSweeps.keys())));
    } catch (e) {
      this.logger?.error(`[Sweep] Failed to persist pending sweeps: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Load any persisted pending sweeps into the in-memory queue (called at start). */
  private async loadPendingSweeps(): Promise<void> {
    try {
      const raw = await this.storage.getItem(SWEEP_PENDING_KEY);
      if (raw) {
        const hexes = JSON.parse(raw) as unknown;
        if (Array.isArray(hexes)) {
          for (const h of hexes) {
            if (typeof h === "string" && h.length > 0 && h.length % 2 === 0 && /^[0-9a-f]+$/i.test(h)) {
              this.pendingSweeps.set(h, hexToBytes(h));
            }
          }
        }
      }
      for (const k of this.pendingSweeps.keys()) if (!this.pendingSweepSats.has(k)) this.pendingSweepSats.set(k, 0);
      const lastRaw = await this.storage.getItem(SWEEP_LAST_KEY);
      if (lastRaw) {
        const parsed = JSON.parse(lastRaw) as { txid?: unknown; sat?: unknown; at?: unknown };
        if (typeof parsed.txid === "string" && typeof parsed.sat === "number" && typeof parsed.at === "number") {
          this.lastSweep = { txid: parsed.txid, sat: parsed.sat, at: parsed.at };
        }
      }
    } catch (e) {
      this.logger?.error(`[Sweep] Failed to load pending sweeps: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * (Re)broadcast every queued force-close sweep; drop each one the node accepts. Idempotent and
   * safe to call repeatedly — invoked from the sync tick, so a sweep that couldn't broadcast (rate
   * limit, offline, mid-restart) keeps retrying until it lands instead of being silently dropped.
   */
  private async broadcastPendingSweeps(): Promise<void> {
    if (this.pendingSweeps.size === 0 || !this.syncClient) return;
    for (const [key, txBytes] of Array.from(this.pendingSweeps)) {
      try {
        await this.syncClient.broadcastTransaction(txBytes);
        this.pendingSweeps.delete(key);
        await this.persistPendingSweeps();
        const sat = this.pendingSweepSats.get(key) ?? 0;
        this.pendingSweepSats.delete(key);
        try {
          const h1 = await crypto.subtle.digest("SHA-256", txBytes as unknown as ArrayBuffer);
          const txid = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", h1)).reverse());
          this.lastSweep = { txid, sat, at: Date.now() };
          await this.storage.setItem(SWEEP_LAST_KEY, JSON.stringify(this.lastSweep));
        } catch (e) {
          this.logger?.warn(`[Sweep] could not record last-sweep metadata: ${e instanceof Error ? e.message : e}`);
        }
        this.notifyStateChanged();
        this.logger?.info("[Sweep] Broadcast a force-close sweep to your address.");
      } catch (e) {
        this.logger?.warn(`[Sweep] Broadcast failed (will retry next sync): ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // --- Peer Connection Adapter ---

  async connectPeer(pubkey: string, host: string, port: number): Promise<void> {
    if (!this.peerManager) {
      throw new Error("Wallet is not running");
    }

    // Remember this peer so we want it connected (auto-reconnect on drop) and can redial it
    // across reloads (persisted address book — see redialChannelPeers). Best-effort persist.
    this.desiredPeers.set(pubkey, { host, port });
    this.peerAddressBook.set(pubkey, { host, port });
    void this.persistPeerAddressBook();

    // Already connected? Check LDK's own peer list too, not just our map: after a duplicate
    // connection is killed ("Got second connection with <peer>, closing"), the duplicate's
    // registration has overwritten — and its death deleted — the map entry for the ORIGINAL
    // still-live connection, so the map alone under-reports. Dialing in that state would
    // just mint the next duplicate (the 1↔2 peer-count flap loop).
    if (this.connectedPeers.has(pubkey) || this.ldkHasPeer(pubkey)) {
      this.logger?.info(`Peer ${pubkey} is already connected`);
      return;
    }

    // Coalesce concurrent dials (e.g. an app-level startup redial racing redialChannelPeers):
    // both callers await the SAME in-flight dial instead of opening two sockets.
    const pending = this.pendingDials.get(pubkey);
    if (pending) return pending;
    const dial = this.dialPeer(pubkey, host, port).finally(() => this.pendingDials.delete(pubkey));
    this.pendingDials.set(pubkey, dial);
    return dial;
  }

  // The actual socket dial + LDK registration. Only ever one in flight per pubkey
  // (connectPeer coalesces); call through connectPeer, never directly.
  private async dialPeer(pubkey: string, host: string, port: number): Promise<void> {
    this.logger?.info(`Connecting to peer: ${pubkey}@${host}:${port}`);

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

    // Re-check after the async socket dial: stop() may have torn the node down meanwhile.
    if (!this.peerManager) {
      descriptorImpl.disconnect_socket();
      throw new Error("Wallet is not running");
    }
    const initialBytesResult = this.peerManager.new_outbound_connection(
      hexToBytes(pubkey),
      descriptor,
      Option_SocketAddressZ.constructor_none()
    );

    if (initialBytesResult.is_ok()) {
      const initialBytes = (initialBytesResult as Result_CVec_u8ZPeerHandleErrorZ_OK).res;
      descriptorImpl.send_data(initialBytes, false);
      this.connectedPeers.set(pubkey, descriptorImpl);
      this.reconnectAttempts.delete(pubkey); // healthy connection — reset backoff
      this.logger?.info(`Successfully connected to peer: ${pubkey}`);
    } else {
      descriptorImpl.disconnect_socket();
      throw new Error("Failed to initialize outbound connection in PeerManager");
    }
  }

  // Persist the peer address book. Best-effort: a failure just means we may need a manual
  // reconnect next start — never let it break a connect or reject.
  private async persistPeerAddressBook(): Promise<void> {
    try {
      const obj = Object.fromEntries(this.peerAddressBook);
      await this.storage.setItem(PEER_ADDRESS_BOOK_KEY, JSON.stringify(obj));
    } catch (e) {
      this.logger?.warn(`[Peer] Could not persist address book: ${e instanceof Error ? e.message : e}`);
    }
  }

  // The persisted peer address book (pubkey → last-known {host, port}). Read-only view for UIs
  // (e.g. a peers screen); works with the node stopped — it reads storage, not live state.
  async getPeerAddresses(): Promise<Record<string, PeerAddress>> {
    return parsePeerAddressBook(await this.storage.getItem(PEER_ADDRESS_BOOK_KEY));
  }

  // On start, redial the peers we hold channels with, using their last-known addresses. This is
  // what keeps a funded channel alive across a reload — LDK stores no peer addresses, and the
  // in-memory desiredPeers list is empty on a fresh start. Gated by autoReconnectPeers; fully
  // best-effort (connectPeer is idempotent + self-schedules backoff redials on failure).
  private async redialChannelPeers(): Promise<void> {
    if (this.config.autoReconnectPeers === false || !this.channelManager) return;
    try {
      this.peerAddressBook = new Map(
        Object.entries(parsePeerAddressBook(await this.storage.getItem(PEER_ADDRESS_BOOK_KEY)))
      );
      const counterparties = this.channelManager
        .list_channels()
        .map((ch: ChannelDetails) => bytesToHex(ch.get_counterparty().get_node_id()));
      const targets = channelPeersToRedial(counterparties, Object.fromEntries(this.peerAddressBook));
      for (const t of targets) {
        this.logger?.info(`[Peer] Auto-reconnecting channel partner ${t.pubkey}@${t.host}:${t.port}`);
        // Fire-and-forget: don't block startup on a slow dial; a failure schedules its own redial.
        this.connectPeer(t.pubkey, t.host, t.port).catch((e) =>
          this.logger?.warn(`[Peer] Auto-reconnect to ${t.pubkey} failed: ${e instanceof Error ? e.message : e}`)
        );
      }
    } catch (e) {
      this.logger?.warn(`[Peer] redialChannelPeers failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Proactively drop and redial every desired peer — call this on app foreground-resume.
   *
   * On iOS a backgrounded PWA is FROZEN (timers paused) and the OS can kill the bridge socket
   * WITHOUT delivering an onclose, leaving a "zombie" half-open connection that LDK still lists as
   * connected. So getBalance()/isUsable look healthy, but a send routes bytes into the dead socket
   * and silently STALLS until the peer tick's ping-timeout finally disconnects it (~10-20s). This
   * collapses that window: it force-closes each peer's current descriptor, tells LDK the socket is
   * gone NOW (so the redial isn't skipped by connectPeer's ldkHasPeer early-return), and redials.
   *
   * Safe to call from an app event (visibilitychange) — NOT from inside a SocketDescriptor callback,
   * so the synchronous socket_disconnected/process_events calls don't hit the re-entrancy trap (see
   * handleDisconnect). Reconnection re-establishes transport only; it never advances channel state.
   */
  async refreshPeerConnections(): Promise<void> {
    const pm = this.peerManager;
    if (!pm || !this.isRunning) return;
    for (const [pubkey, addr] of [...this.desiredPeers.entries()]) {
      const desc = this.connectedPeers.get(pubkey);
      if (desc) {
        // Drop from the map FIRST so the handleDisconnect that disconnect_socket() fires doesn't
        // ALSO scheduleReconnect — we redial ourselves below.
        this.connectedPeers.delete(pubkey);
        try {
          desc.disconnect_socket();
        } catch {
          /* transport already gone */
        }
        // Force LDK to forget the (possibly zombie) peer synchronously; otherwise ldkHasPeer() stays
        // true and connectPeer's idempotent early-return would skip the redial. A duplicate
        // socket_disconnected (also deferred by handleDisconnect) is a documented no-op.
        try {
          pm.socket_disconnected(SocketDescriptor.new_impl(desc));
        } catch {
          /* already gone */
        }
      }
      void this.connectPeer(pubkey, addr.host, addr.port).catch((e) =>
        this.logger?.warn(`[Peer] resume refresh redial ${pubkey} failed: ${e instanceof Error ? e.message : e}`)
      );
    }
    pm.process_events();
  }

  handleDisconnect(desc: WebSocketDescriptor): void {
    if (this.connectedPeers.get(desc.peerPubkey)?.id === desc.id) {
      this.connectedPeers.delete(desc.peerPubkey);
      this.logger?.info(`Disconnected peer: ${desc.peerPubkey}`);
      // The current connection for this peer dropped — keep it alive by redialing.
      this.scheduleReconnect(desc.peerPubkey);
    }
    // Inform LDK the socket closed — but OUTSIDE this call stack. LDK invokes our
    // SocketDescriptor.disconnect_socket() re-entrantly from within timer_tick_occurred()/
    // process_events() when it drops a stale peer, so calling back into PeerManager here
    // synchronously triggers "already borrowed: BorrowMutError" -> a WASM `unreachable`
    // trap (surfaces on the minified PWA as "unreachable executed"), which kills
    // auto-reconnect for good. Deferring to a microtask lets the in-flight PeerManager call
    // unwind and release its borrow first. socket_disconnected after an LDK-initiated
    // disconnect is a documented no-op, so this is safe for both the LDK-initiated and the
    // transport-drop (onclose/onerror) paths.
    const pm = this.peerManager;
    if (pm) {
      queueMicrotask(() => {
        // stop() frees this.peerManager; skip if the node was torn down or restarted.
        if (this.peerManager !== pm) return;
        pm.socket_disconnected(SocketDescriptor.new_impl(desc));
        pm.process_events();
      });
    }
  }

  /**
   * Schedule a backoff redial of a dropped peer. No-op when auto-reconnect is disabled,
   * the node is stopped, the peer is no longer desired, it's already reconnected, or a
   * reconnect is already pending. Reschedules itself (growing backoff) until it succeeds.
   */
  private scheduleReconnect(pubkey: string): void {
    if (this.config.autoReconnectPeers === false) return;
    if (!this.isRunning) return;
    const target = this.desiredPeers.get(pubkey);
    if (!target) return;
    if (this.connectedPeers.has(pubkey)) return;
    if (this.reconnectTimers.has(pubkey)) return;

    const attempt = (this.reconnectAttempts.get(pubkey) ?? 0) + 1;
    this.reconnectAttempts.set(pubkey, attempt);
    const delay = reconnectDelayMs(attempt);
    this.logger?.info(`[Reconnect] peer ${pubkey} dropped — retrying in ${delay}ms (attempt ${attempt})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(pubkey);
      // Re-check on fire — including LDK's own peer list (safe here: a timer callback is never
      // inside an LDK call stack). If LDK still holds a live connection, this "drop" was a
      // killed duplicate and redialing would mint the next one.
      const redial = shouldRedialNow({
        running: this.isRunning,
        desired: this.desiredPeers.has(pubkey),
        connectedInMap: this.connectedPeers.has(pubkey),
        connectedInLdk: this.ldkHasPeer(pubkey),
      });
      if (!redial) {
        this.reconnectAttempts.delete(pubkey); // nothing to chase — reset the backoff
        return;
      }
      try {
        await this.connectPeer(pubkey, target.host, target.port);
      } catch (e) {
        this.logger?.warn(`[Reconnect] peer ${pubkey} attempt ${attempt} failed: ${e instanceof Error ? e.message : e}`);
        this.scheduleReconnect(pubkey); // try again with a longer backoff
      }
    }, delay);
    this.reconnectTimers.set(pubkey, timer);
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
      { jit_channel_scid: string; lsp_node_id: string; cltv_expiry_delta: number }
    >("lsps2.buy", {
      version: 1,
      opening_fee_params: selectedFeeParams,
      payment_hash: paymentHashHex,
      client_node_id: bytesToHex(this.channelManager.get_our_node_id()),
    });

    // 3. Build the intercept route hint from the LSP's response. The jit_channel_scid is the scid
    // lnd forwards+intercepts on; the payer must route through the LSP via it. The opening fee is
    // skimmed by the interceptor (not carried as a hop fee), so the hop fee is 0 — the LSP sets its
    // channel routing policy to match. cltv comes from the buy response (falling back to the menu).
    if (!/^\d+$/.test(buyRes.jit_channel_scid)) {
      throw new Error(`LSP returned an invalid jit_channel_scid: ${buyRes.jit_channel_scid}`);
    }
    if (!/^[0-9a-fA-F]{66}$/.test(buyRes.lsp_node_id ?? "")) {
      throw new Error(`LSP returned an invalid lsp_node_id: ${buyRes.lsp_node_id}`);
    }
    const jitHint: HintHop = {
      srcNodeId: buyRes.lsp_node_id,
      scid: BigInt(buyRes.jit_channel_scid),
      feeBaseMsat: 0,
      feeProportionalMillionths: 0,
      cltvExpiryDelta: buyRes.cltv_expiry_delta ?? selectedFeeParams.cltv_expiry_delta ?? 144,
    };

    // 4. Generate the BOLT11 invoice with the same payment hash via the shared builder, forcing the
    // intercept hint (preimage persisted for the claim path).
    const { invoice: invoiceStr } = await this.buildInvoice(amountMsat, description, DEFAULT_INVOICE_EXPIRY_SECONDS, preimage, jitHint);
    this.logger?.info(`[LSPS2] Generated JIT invoice with intercept scid ${buyRes.jit_channel_scid}`);

    return invoiceStr;
  }

  // --- LSPS1 Inbound Capacity Purchase ---

  /**
   * Buy inbound liquidity from a real mainnet LSP over the LSPS1 REST binding (bLIP-51 HTTP: Megalith,
   * Olympus/ZEUS). `lsp.api_url` is the REST base (e.g. https://megalithic.me/api/lsps1/v1). Reads the
   * LSP's live `uris` to dial its node, places the order, and returns the BOLT11 to pay + the order id
   * (poll `getLSPS1Order` after paying until the channel opens). 0-conf is requested only when the LSP
   * offers it AND its pubkey is in `trustedZeroConfPeers` (guardrail: never 0-conf from an unvetted node).
   */
  async purchaseLSPS1Capacity(options: {
    amountSats: number;
    lsp: LspProvider; // api_url = the LSPS1 REST base URL
    // Lease duration in blocks, clamped to [1, LSP max]; defaults to the LSP max (longest lease
    // per open fee — right for an infrequently-online listener wallet).
    channelExpiryBlocks?: number;
    announceChannel?: boolean; // default false (a browser node has no reachable address to announce)
    refundOnchainAddress?: string; // where the LSP refunds if the order fails/expires (optional)
  }): Promise<{ orderId: string; invoice: string; feeTotalSat?: string; onchainAddress?: string; lspPeerUri?: string }> {
    if (!this.channelManager) {
      throw new Error("Wallet is not running");
    }

    const { amountSats, lsp } = options;
    this.logger?.info(`[LSPS1] Purchasing ${amountSats} sats inbound capacity from ${lsp.name}`);
    const client = new Lsps1RestClient({ baseUrl: lsp.api_url, logger: this.logger });

    // 1. get_info — bounds, 0-conf capability, and the peer uris to dial.
    const info = await client.getInfo();
    const amt = BigInt(Math.round(amountSats));
    if (amt < BigInt(info.min_channel_balance_sat) || amt > BigInt(info.max_channel_balance_sat)) {
      throw new Error(`Requested ${amountSats} sat is outside ${lsp.name} bounds [${info.min_channel_balance_sat}, ${info.max_channel_balance_sat}]`);
    }
    const channelExpiryBlocks = clampExpiryBlocks(options.channelExpiryBlocks, info.max_channel_expiry_blocks);

    // 2. Dial the LSP node (read live from get_info uris) — it opens the channel over this peer link.
    //    Best-effort: a browser node reaches peers only through its configured websockify bridge,
    //    which must front this LSP; log a warning but still place the order if the dial fails.
    const peerUri = info.uris?.[0];
    const lspPubkey = peerUri ? peerUri.split("@")[0] : lsp.pubkey;
    if (peerUri) {
      try {
        const addrPort = peerUri.slice(peerUri.indexOf("@") + 1);
        const lastColon = addrPort.lastIndexOf(":");
        await this.connectPeer(lspPubkey, addrPort.slice(0, lastColon), parseInt(addrPort.slice(lastColon + 1), 10));
      } catch (e) {
        this.logger?.warn(`[LSPS1] Could not dial LSP peer ${peerUri}: ${(e as Error)?.message ?? e}. Order still placed; ensure the wallet's bridge fronts this node before paying.`);
      }
    }

    // 3. 0-conf only when the LSP offers it AND we've allowlisted its pubkey.
    const trusts0conf = (this.config.trustedZeroConfPeers ?? []).includes(lspPubkey);
    const requiredConfs = info.min_required_channel_confirmations === 0 && trusts0conf ? 0 : info.min_required_channel_confirmations ?? 6;

    // 4. create_order (bLIP-51 REST uses `public_key` for the client node).
    const order = await client.createOrder({
      lsp_balance_sat: String(amountSats),
      client_balance_sat: "0",
      required_channel_confirmations: requiredConfs,
      funding_confirms_within_blocks: info.min_funding_confirms_within_blocks ?? 6,
      channel_expiry_blocks: channelExpiryBlocks,
      announce_channel: options.announceChannel ?? false,
      public_key: bytesToHex(this.channelManager.get_our_node_id()),
      ...(options.refundOnchainAddress ? { refund_onchain_address: options.refundOnchainAddress } : {}),
    });

    const invoice = orderInvoice(order);
    if (!invoice) {
      throw new Error(`${lsp.name} create_order returned no BOLT11 invoice`);
    }
    this.logger?.info(`[LSPS1] Order ${order.order_id} placed (lease ${channelExpiryBlocks} blk, ${requiredConfs}-conf). Pay: ${invoice}`);
    return {
      orderId: order.order_id,
      invoice,
      feeTotalSat: order.payment?.bolt11?.fee_total_sat,
      onchainAddress: order.payment?.onchain?.address,
      lspPeerUri: peerUri,
    };
  }

  // Poll an LSPS1 order's status after paying its invoice (until order_state COMPLETED/FAILED and the
  // channel opens). Stateless REST GET against the same LSP base URL.
  async getLSPS1Order(apiUrl: string, orderId: string): Promise<Lsps1RestOrderResponse> {
    return new Lsps1RestClient({ baseUrl: apiUrl, logger: this.logger }).getOrder(orderId);
  }

  // --- Value-for-Value Keysend & Splits Implementation ---

  // On resume-from-background the channel peer reconnects over ~0.5–2s; a payment attempted in that
  // window fails RouteNotFound (no usable first-hop yet) and an NWC client sees it as failed. If we
  // HAVE a channel but none is usable right now, wait briefly for the peer to come back before
  // routing. Pure wait — nothing is sent, so no double-pay risk. Returns true once a channel is
  // usable (or one already was), false on timeout (caller then attempts anyway, failing as before).
  // A wallet with NO channels doesn't wait — there's nothing to wait for.
  private async awaitUsableChannel(timeoutMs = 8000, pollMs = 250): Promise<boolean> {
    const mgr = this.channelManager;
    if (!mgr) return false;
    if (mgr.list_channels().length === 0) return false;
    const usable = () => mgr.list_channels().some((c: ChannelDetails) => c.get_is_usable());
    const ok = await pollUntil(usable, { timeoutMs, pollMs });
    if (!ok) {
      this.logger?.warn(`[Pay] No usable channel after ${timeoutMs}ms — peer may be reconnecting; attempting anyway.`);
    }
    return ok;
  }

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
    // Wait out a brief peer-reconnect window (resume-from-background) so the boost doesn't fail
    // RouteNotFound. No-op when a channel is already usable.
    await this.awaitUsableChannel();

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
        // The payment is now irrevocably in flight. Persisting the preimage is a
        // best-effort convenience (self-payment claim lookup) — a storage failure
        // here must NOT flip the result to ok:false, or the NWC layer reports the
        // send as failed and the client retries → the recipient is paid twice.
        try {
          await this.storage.setItem(`preimage_${paymentHashHex}`, bytesToHex(preimage));
        } catch (e) {
          this.logger?.error(`[Keysend] Payment initiated but failed to persist preimage: ${e instanceof Error ? e.message : e}`);
        }
        // Record the outbound intent for the payment history (finalized on Event_PaymentSent /
        // Event_PaymentFailed). Amount + destination + boostagram note are only known here.
        this.paymentLog.notePending({
          id: paymentHashHex,
          direction: "sent",
          status: "pending",
          amountSats,
          timestamp: Date.now(),
          counterparty: destinationPubkey,
          type: "keysend",
          note: boostNoteFromCustomRecords(customRecords),
        });
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

  // Pay an amount-carrying BOLT11 invoice. Mirrors the NWC pay_invoice LDK plumbing with a
  // public, typed surface. Fund-safety rules encoded here:
  //  - all validation happens BEFORE any side effect (no stranded pending records);
  //  - a send_payment error is a definitive failure → the pending record is finalized failed;
  //  - once send_payment succeeds the payment is in flight: a settlement-wait timeout throws
  //    PaymentTimeoutError (pending — check history), NEVER a plain failure, so callers can't
  //    blind-retry into a double-pay.
  async payBolt11(bolt11: string): Promise<{ preimage: string; amountSats: number }> {
    const mgr = this.channelManager;
    if (!mgr) throw new Error("Wallet not started");

    const invoiceRes = Bolt11Invoice.constructor_from_str(bolt11.trim());
    if (!invoiceRes.is_ok()) throw new Error("Invalid BOLT11 invoice");
    const invoice = (invoiceRes as any).res as Bolt11Invoice;

    const amtOpt = invoice.amount_milli_satoshis();
    if (!(amtOpt instanceof Option_u64Z_Some) || amtOpt.some <= 0n) {
      throw new Error("Zero-amount invoices are not supported");
    }
    const amountSats = Number(amtOpt.some / 1000n);

    const paramRes = UtilMethods.constructor_payment_parameters_from_invoice(invoice);
    if (!paramRes.is_ok()) throw new Error("Failed to construct payment parameters from invoice");
    const tuple = (paramRes as Result_C3Tuple_ThirtyTwoBytesRecipientOnionFieldsRouteParametersZNoneZ_OK).res;
    const paymentHash = tuple.get_a();
    const onionFields = tuple.get_b();
    const routeParams = tuple.get_c();
    const hashHex = bytesToHex(paymentHash);

    // Wait out a brief peer-reconnect window (resume-from-background) so the pay doesn't fail
    // RouteNotFound before the channel is usable again. No-op when a channel is already usable;
    // nothing has been sent yet, so no double-pay risk.
    await this.awaitUsableChannel();

    // Register the settlement waiter BEFORE send_payment so a fast Event_PaymentSent can't race it.
    const settled = new Promise<string>((resolve, reject) => {
      this.settlementWaiters.set(hashHex, { resolve, reject });
    });

    // Record the outbound intent for the payment history (finalized by the event demux).
    this.paymentLog.notePending({
      id: hashHex,
      direction: "sent",
      status: "pending",
      amountSats,
      timestamp: Date.now(),
      type: "bolt11",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const paymentId = new Uint8Array(32);
      crypto.getRandomValues(paymentId);
      const sendRes = mgr.send_payment(paymentHash, onionFields, paymentId, routeParams, Retry.constructor_attempts(10));
      if (!sendRes.is_ok()) {
        // Nothing left the node — a definitive failure. Finalize the record so it never
        // strands as pending, and surface a plain error (safe to retry).
        this.paymentLog.recordFailed(hashHex);
        const errStr = (sendRes as any).err?.toString() || "route not found";
        this.logger?.error(`[Pay] send_payment failed to initiate: ${errStr}`);
        throw new Error(`Payment failed to initiate: ${errStr}`);
      }

      this.logger?.info(`[Pay] BOLT11 payment initiated, hash: ${hashHex}, ${amountSats} sats`);
      const preimage = await Promise.race([
        settled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PaymentTimeoutError(hashHex)), 90_000);
        }),
      ]);
      return { preimage, amountSats };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.settlementWaiters.delete(hashHex);
      // The waiter promise may reject after we've already left (timeout path) — detach it so
      // a late Event_PaymentFailed never surfaces as an unhandled rejection.
      void settled.catch(() => {});
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
export type { WalletConfig, PaymentRecord } from "@libre/shared";
export { PaymentLogger, boostNoteFromCustomRecords, TX_KEY_PREFIX } from "./payment-log";
export { CloseLogger, CLOSE_KEY_PREFIX } from "./close-log";
export type { ChannelCloseRecord, ChannelCloseReason } from "./close-log";
export { LspsClient } from "./lsps-client";
export { Lsps1RestClient, clampExpiryBlocks, isOrderComplete, isOrderFailed, orderInvoice } from "./lsps1-rest-client";
export { VssClient, VssError, isVssConflict, isVssNotFound } from "./vss-client";
export type { VssClientConfig, VssKeyValue, ListKeyVersionsResult } from "./vss-client";
export { VssMirror, deriveVssStoreId, VSS_STATE_BACKUP_KEY } from "./vss-mirror";
export { VssDeviceLease, VSS_DEVICE_LEASE_KEY } from "./vss-device-lease";
export { CrossDeviceLockError } from "./cross-device-lease-error";
export { hasRouteHint, appendRouteHints, type HintHop } from "./bolt11-hints";
export { resolveLnAddressInvoice, type ResolvedLnAddressInvoice } from "./lnurl-client";
export {
  seedHexToMnemonic,
  mnemonicToSeedHex,
  isValidSeedMnemonic,
  normalizeMnemonic,
  normalizeBackupSecret,
} from "./seed-phrase";
