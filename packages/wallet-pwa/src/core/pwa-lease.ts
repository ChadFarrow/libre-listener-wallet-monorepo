// The wallet PWA's participation in the cross-origin roaming lease (see wallet-core's
// roaming/ + docs/roaming-protocol.md). Without this, a PWA node is invisible to an embedded
// widget's lease and vice versa → two live nodes on one channel.
//
// The PWA deliberately keeps its OFFLINE-FIRST start behavior (the iOS cold-load fix): with
// Drive unreachable there is no lease to consult, so starts proceed exactly as before. The
// lease engages whenever Drive IS connected:
//   - BEFORE a guarded start (startNodeWithGuards): a live foreign lease blocks the start with
//     "active on <origin>".
//   - WHILE RUNNING: we claim + heartbeat; an eviction (an embed claimed the wallet) stops the
//     node, flushes the backup if it's ahead of Drive, and writes the handoff ack.
//   - Auto-start can race Drive connectivity (the node may start before the token exists). The
//     state-changed hook closes that window reactively: the first claim attempt that finds a
//     live foreign lease SELF-FENCES (stop + flush) instead of running alongside it.

import {
  RoamingLease,
  dbNameForNetwork,
  downloadBackup,
  driveLeaseStore,
  leaseFilename,
  leaseState,
  parseLeaseRecord,
  readAppDataFile,
  uploadBackup,
  writeAppDataFile,
  type RoamingLeaseRecord,
  type WalletControllerApi,
} from "@libre/wallet-core";
import { IndexedDBStorageProvider, verifyBackupEnvelope } from "@libre/listener-wallet";

/** I/O seams, injectable for tests; defaults are the real Drive/IndexedDB implementations. */
export interface PwaLeaseIo {
  readFile: typeof readAppDataFile;
  writeFile: typeof writeAppDataFile;
  downloadBackup: typeof downloadBackup;
  uploadBackup: typeof uploadBackup;
  storageGet: (network: string, key: string) => Promise<string | null>;
  /** Decrypt-only backup verification. A seam so tests can state a backup's version without minting
   *  real encrypted envelopes; production always uses the SDK's own verifier. */
  verifyEnvelope: typeof verifyBackupEnvelope;
}

const realIo: PwaLeaseIo = {
  readFile: readAppDataFile,
  writeFile: writeAppDataFile,
  downloadBackup,
  uploadBackup,
  storageGet: (network, key) => new IndexedDBStorageProvider(dbNameForNetwork(network)).getItem(key),
  verifyEnvelope: verifyBackupEnvelope,
};

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function localStateVersion(network: string, io: PwaLeaseIo): Promise<number> {
  try {
    const raw = await io.storageGet(network, "state_version");
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/** The state_version the Drive backup actually holds (0 when absent/unreadable) — i.e. how far our
 *  last flush got. Both callers need it: fence() to decide whether to upload, release() to decide
 *  whether it may honestly claim `released`. Never throws; 0 is the conservative answer. */
async function driveBackupVersion(network: string, io: PwaLeaseIo): Promise<number> {
  try {
    const seed = await io.storageGet(network, "ldk_seed");
    if (!seed) return 0;
    const remote = await io.downloadBackup(network);
    if (!remote) return 0;
    const v = await io.verifyEnvelope(remote, seed);
    return v.ok && typeof v.stateVersion === "number" ? v.stateVersion : 0;
  } catch {
    return 0;
  }
}

/** Peek-only pre-start gate: the origin currently holding a LIVE lease, or null when starting is
 *  fine. Drive-unreachable resolves null — the PWA's offline-first start behavior is unchanged. */
export async function leaseHolderBlockingStart(
  network: string,
  driveConnected: boolean,
  io: PwaLeaseIo = realIo,
): Promise<string | null> {
  if (!driveConnected) return null;
  try {
    const file = await io.readFile(leaseFilename(network));
    const record = parseLeaseRecord(file?.contents ?? null);
    return leaseState(record, "pwa-prestart-peek", Date.now()) === "foreignLive"
      ? (record as RoamingLeaseRecord).origin
      : null;
  } catch {
    return null; // unreachable lease never blocks the PWA (offline-first)
  }
}

export const WALLET_MOVED_MSG = (origin: string) =>
  `Your wallet is now active on ${origin} — it was moved there, so this node stopped to keep your channel safe.`;

export interface PwaLeaseDeps {
  controller: WalletControllerApi;
  driveConnected: () => boolean;
  isDemo?: () => boolean;
  onMoved?: (origin: string) => void;
  origin?: string; // defaults to location.origin
  io?: PwaLeaseIo;
  /** Lease timing injection (tests). */
  leaseTuning?: { delay?: (ms: number) => Promise<void>; now?: () => number };
}

/**
 * Event-driven lease keeper: call once from main.ts, then feed it every controller event.
 * Claims + heartbeats while the node runs with Drive connected; releases on stop; self-fences
 * (stop + flush-if-ahead + ack) when another origin claims the wallet.
 */
export function createPwaLeaseKeeper(deps: PwaLeaseDeps): { onEvent: () => void } {
  const io = deps.io ?? realIo;
  let lease: RoamingLease | null = null;
  let network = "";
  let claiming = false;

  const fence = async (claimant: RoamingLeaseRecord | null, ackVia: RoamingLease): Promise<void> => {
    const origin = claimant?.origin ?? "another device";
    try {
      await deps.controller.stopNode();
    } catch {
      /* best-effort — fencing is what matters */
    }
    try {
      // Flush ONLY if local is ahead of Drive (never clobber the successor's restore + flush).
      const version = await localStateVersion(network, io);
      const backupVersion = await driveBackupVersion(network, io);
      if (version > backupVersion) {
        const envelope = await deps.controller.exportBackup();
        await io.uploadBackup(envelope, network);
      }
      await ackVia.writeHandoffAck(version);
    } catch {
      /* best-effort — the claimant also proceeds on timeout + the gap check */
    }
    deps.onMoved?.(origin);
  };

  const claimAndHeartbeat = async (): Promise<void> => {
    if (claiming || lease) return;
    claiming = true;
    try {
      const state = await deps.controller.getState();
      network = state.network;
      const candidate = new RoamingLease(driveLeaseStore(network, { readFile: io.readFile, writeFile: io.writeFile }), {
        ownerToken: randomToken(),
        origin: deps.origin ?? location.origin,
        appName: "libre-wallet-pwa",
        getStateVersion: () => localStateVersion(network, io),
        delay: deps.leaseTuning?.delay,
        now: deps.leaseTuning?.now,
      });
      // Already running when we first see the lease (the auto-start ↔ Drive-connect race): a
      // live foreign holder wins — self-fence rather than run alongside it.
      const peek = await candidate.peek();
      if (peek.state === "foreignLive") {
        await fence(peek.record, candidate);
        return;
      }
      await candidate.acquire();
      lease = candidate;
      candidate.startHeartbeat({
        onEvicted: (claimant) => {
          const l = lease;
          lease = null;
          if (l) void fence(claimant, l);
        },
        onOutageFence: () => {
          lease = null;
          void deps.controller.stopNode().catch(() => {});
          deps.onMoved?.("(Google Drive unreachable — wallet paused)");
        },
      });
    } catch (e) {
      console.warn("[Lease] claim failed (start unaffected):", (e as Error)?.message || e);
    } finally {
      claiming = false;
    }
  };

  // Stopping the node releases the lease — but `released` is the strongest proof a successor gets,
  // so it must be earned, not assumed. The Drive auto-sync is debounced, so a stop can land with
  // local state that never reached the cloud; claiming a clean handoff there would invite the next
  // origin to restore a stale backup onto a live channel. Tell release() how far the flush really
  // got and let it stay honestly `live` when we're ahead.
  const release = async (): Promise<void> => {
    const l = lease;
    lease = null;
    if (!l) return;
    await l.release({
      localStateVersion: await localStateVersion(network, io),
      flushedVersion: await driveBackupVersion(network, io),
    });
  };

  return {
    onEvent: () => {
      if (deps.isDemo?.()) return;
      if (deps.controller.isRunning()) {
        if (deps.driveConnected()) void claimAndHeartbeat();
      } else {
        void release();
      }
    },
  };
}
