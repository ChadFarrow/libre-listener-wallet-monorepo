// Wires the REAL implementations into the roaming session: the WalletController (node lifecycle),
// the Drive backup/lease files, and the SDK's pure envelope verifier. Everything the session
// touches goes through RoamingPorts, so this file is the only place the embed binds to real I/O.

import {
  IndexedDBStorageProvider,
  verifyBackupEnvelope,
} from "@libre/listener-wallet";
import {
  DRIVE_SYNC_DEBOUNCE_MS,
  RoamingLease,
  RoamingSession,
  WalletController,
  dbNameForNetwork,
  downloadBackup,
  driveLeaseStore,
  isConnected as driveIsConnected,
  readAppDataFile,
  shouldDriveAutoSync,
  uploadBackup,
  writeAppDataFile,
  writeAppDataFileSyncKeepalive,
  type RoamingPorts,
  type RoamingViewState,
} from "@libre/wallet-core";

export interface EmbedSessionOptions {
  network: string;
  wasmUrl: string;
  appName?: string;
  origin?: string; // defaults to location.origin
  onState(state: RoamingViewState): void;
  onControllerEvent?(event: string, payload?: unknown): void;
}

export interface EmbedSession {
  controller: WalletController;
  session: RoamingSession;
  /** The early close hook (visibilitychange → hidden), while the page is still ALIVE and can await:
   *  flush any pending state, then record a clean release. This is what keeps a normal
   *  close-the-phone-and-open-the-laptop handoff proven, and therefore keeps the successor's
   *  fail-closed halt rare enough to still mean something. */
  closeSoon(): Promise<void>;
  /** The last-resort close hook (pagehide), when nothing can be awaited any more: SYNCHRONOUSLY
   *  issue a final lease write. It records `released` only if the backup already provably holds our
   *  state; otherwise it honestly leaves the lease live at our true version so the next origin
   *  halts instead of restoring a backup we outran. Returns false when nothing could be issued.
   *  Deliberately does NOT try to flush the backup: exporting is async by nature, so a page-death
   *  flush cannot be issued in time — the previous code awaited exportBackup() here and therefore
   *  never sent anything at all (issue #90). */
  releaseSync(): boolean;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createEmbedSession(opts: EmbedSessionOptions): EmbedSession {
  const network = opts.network;
  const storage = () => new IndexedDBStorageProvider(dbNameForNetwork(network));

  const readLocal: RoamingPorts["readLocal"] = async () => {
    const s = storage();
    const seedHex = await s.getItem("ldk_seed");
    const versionRaw = await s.getItem("state_version");
    return {
      seedPresent: !!seedHex,
      seedHex: seedHex || null,
      stateVersion: versionRaw ? parseInt(versionRaw, 10) || 0 : 0,
    };
  };

  // The two numbers the close path needs SYNCHRONOUSLY (it can't await a read): how far our state
  // has got, and how far Drive provably has it. Their difference is the unflushed window.
  let localVersion = 0;
  let flushedVersion = 0;

  /** THE flush path. Reads the version BEFORE exporting so we never over-claim: a payment landing
   *  mid-export would otherwise make us assert a version the uploaded envelope doesn't contain, and
   *  an over-claimed flushedVersion is a false proof of a clean handoff. Under-claiming just costs a
   *  redundant re-sync. */
  const flushTracked = async (): Promise<number> => {
    const v = (await readLocal()).stateVersion;
    const envelope = await controller.exportBackup();
    await uploadBackup(envelope, network);
    flushedVersion = Math.max(flushedVersion, v);
    return v;
  };

  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelPendingSync = () => {
    if (syncTimer !== undefined) clearTimeout(syncTimer);
    syncTimer = undefined;
  };

  const controller = new WalletController(
    (event, payload) => {
      opts.onControllerEvent?.(event, payload);
      void readLocal()
        .then((l) => {
          localVersion = l.stateVersion;
        })
        .catch(() => {
          /* best-effort bookkeeping — the close path degrades to "can't prove it", which halts */
        });
      // Keep Drive current while we hold the wallet. Without this the embed's backup sat frozen at
      // whatever version it roamed in with, for the whole session — so the next origin's takeover
      // restored a snapshot the channel had long outrun and the peer force-closed it (#90).
      if (!shouldDriveAutoSync({ event, demo: false, running: controller.isRunning(), driveConnected: driveIsConnected() })) {
        return;
      }
      // Only while we're cleared to own the wallet: uploading from a halted/moving session would
      // push state the proof gate has not let us take responsibility for.
      if (session.current().view !== "running") return;
      cancelPendingSync();
      syncTimer = setTimeout(() => {
        void flushTracked().catch(() => {
          /* best-effort: the next state change re-arms, and an unflushed close halts, never restores */
        });
      }, DRIVE_SYNC_DEBOUNCE_MS);
    },
    { wasmUrl: opts.wasmUrl },
  );

  const ports: RoamingPorts = {
    readLocal,
    fetchBackup: () => downloadBackup(network),
    verifyEnvelope: (envelope, secret) => verifyBackupEnvelope(envelope, secret),
    startNode: async () => {
      await controller.startNode();
    },
    stopNode: async () => {
      await controller.stopNode();
    },
    restore: async (envelope, secret) => {
      await controller.restoreWallet(envelope, secret);
    },
    flushBackup: flushTracked,
  };

  const lease = new RoamingLease(
    driveLeaseStore(network, {
      readFile: readAppDataFile,
      writeFile: writeAppDataFile,
      writeFileSyncKeepalive: writeAppDataFileSyncKeepalive,
    }),
    {
      ownerToken: randomToken(),
      origin: opts.origin ?? location.origin,
      appName: opts.appName,
      getStateVersion: async () => (await readLocal()).stateVersion,
    },
  );

  const session = new RoamingSession(lease, ports, opts.onState);

  return {
    controller,
    session,
    async closeSoon() {
      if (session.current().view !== "running") return;
      cancelPendingSync();
      try {
        const local = (await readLocal()).stateVersion;
        localVersion = local;
        if (flushedVersion < local) await flushTracked();
        await lease.release({ localStateVersion: local, flushedVersion });
      } catch {
        /* best-effort: an unproven close halts the next origin, which is the safe failure */
      }
    },
    releaseSync() {
      return lease.releaseSyncKeepalive({ localStateVersion: localVersion, flushedVersion });
    },
  };
}
