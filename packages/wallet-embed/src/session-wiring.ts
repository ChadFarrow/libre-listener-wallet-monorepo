// Wires the REAL implementations into the roaming session: the WalletController (node lifecycle),
// the Drive backup/lease files, and the SDK's pure envelope verifier. Everything the session
// touches goes through RoamingPorts, so this file is the only place the embed binds to real I/O.

import {
  IndexedDBStorageProvider,
  verifyBackupEnvelope,
} from "@libre/listener-wallet";
import {
  RoamingLease,
  RoamingSession,
  WalletController,
  backupModifiedTime,
  dbNameForNetwork,
  downloadBackup,
  driveLeaseStore,
  readAppDataFile,
  uploadBackup,
  writeAppDataFile,
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
  /** Best-effort emergency flush for pagehide (keepalive-fetch friendly: the envelope is KB-sized). */
  emergencyFlush(): void;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createEmbedSession(opts: EmbedSessionOptions): EmbedSession {
  const controller = new WalletController(
    (event, payload) => opts.onControllerEvent?.(event, payload),
    { wasmUrl: opts.wasmUrl },
  );
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

  const ports: RoamingPorts = {
    readLocal,
    fetchBackup: () => downloadBackup(network),
    verifyEnvelope: (envelope, secret) => verifyBackupEnvelope(envelope, secret),
    backupModifiedTime: () => backupModifiedTime(network),
    startNode: async () => {
      await controller.startNode();
    },
    stopNode: async () => {
      await controller.stopNode();
    },
    restore: async (envelope, secret) => {
      await controller.restoreWallet(envelope, secret);
    },
    flushBackup: async () => {
      const envelope = await controller.exportBackup();
      await uploadBackup(envelope, network);
      return (await readLocal()).stateVersion;
    },
  };

  const lease = new RoamingLease(
    driveLeaseStore(network, { readFile: readAppDataFile, writeFile: writeAppDataFile }),
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
    emergencyFlush() {
      // pagehide path: fire-and-forget — the browser keeps issued keepalive fetches alive after
      // page death; a lost flush is caught by the crash-gap check on the next origin.
      void (async () => {
        try {
          const envelope = await controller.exportBackup();
          await uploadBackup(envelope, network);
        } catch {
          /* best-effort */
        }
      })();
    },
  };
}
