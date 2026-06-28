import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "@libre/listener-wallet";

// Boot MSW browser worker conditionally in development mode to intercept LSP API (9099) requests
if (import.meta.env.DEV) {
  const { worker } = await import("./mocks");
  await worker.start({
    onUnhandledRequest: "bypass",
  });
}



// 1. Browser websocket connection provider for LDK
class BrowserWebSocketStreamProvider implements WebSocketStreamProvider {
  async connect(address: string, port: number): Promise<WebSocketConnection> {
    // Bridge browser WebSocket to LND TCP port 9735 via websockify at 127.0.0.1:8091
    const wsUrl =
      (document.getElementById("ws-bridge-url") as HTMLInputElement | null)?.value?.trim() ||
      "ws://127.0.0.1:8091";
    appendLog(`[SYSTEM] Connecting WebSocket bridge to ${wsUrl} (LND peer at ${address}:${port})...`, "system");
    
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";

    const conn: WebSocketConnection = {
      send: (data: Uint8Array) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
      },
      close: () => {
        socket.close();
      },
    };

    socket.onmessage = (event) => {
      conn.onmessage?.(new Uint8Array(event.data));
    };

    socket.onerror = (err) => {
      conn.onerror?.(new Error("WebSocket error"));
    };

    socket.onclose = () => {
      conn.onclose?.();
    };

    return new Promise((resolve, reject) => {
      socket.onopen = () => {
        appendLog(`[SYSTEM] WebSocket bridge connected to LSP peer!`, "system");
        resolve(conn);
      };
      socket.onerror = (err) => {
        appendLog(`[ERROR] WebSocket bridge failed to connect to ${wsUrl}`, "error");
        reject(new Error("WebSocket failed to connect"));
      };
    });
  }
}

// 2. Browser IndexedDB storage implementation for LDK settings
import { IndexedDBStorageProvider } from "@libre/listener-wallet";
import * as drive from "./drive-backup";
import { appendLog, initLogControls } from "./core/logger";
import { copyToClipboard } from "./core/ui-helpers";
import type { AppContext } from "./core/app-context";
import { initWebPush } from "./web-push";
import { initNwcUi, setNwcEnabled, updateNwcConnectionsList } from "./nwc-ui";
import { initV4V, setV4VEnabled } from "./v4v";
import { ensurePersistentStorage } from "./core/persistent-storage";
import { dbNameForNetwork, migrateStorage, META_DB_NAME, ACTIVE_NETWORK_KEY } from "./core/storage-namespace";
import { rgsUrlForNetwork } from "./core/rgs-config";
let storage!: IndexedDBStorageProvider; // assigned in the init IIFE via refreshWalletForNetwork

// Persist the active network to the meta DB so off-page code (SW, simulate-offline)
// can open the correct network-scoped DB without reading the main app's state.
async function setActiveNetwork(network: string): Promise<void> {
  await new IndexedDBStorageProvider(META_DB_NAME).setItem(ACTIVE_NETWORK_KEY, network);
}

// 3. Logger helper to update UI terminal console
// 4. Wallet Lifecycle State
let wallet: LibreListenerWallet | null = null;
let isNodeRunning = false;
// Seed shown to the user but not yet created (Create New Wallet → Create Wallet).
let pendingSeed: string | null = null;
// Set when a wallet was just created, so the next start runs the backup check.
let justCreated = false;
// 5s poll handle for the balance/channels view while the node runs.
let walletViewTimer: any = null;
// Set when the wallet is auto-started on page load, so the start handler knows to
// also auto-connect the peer once the node is running.
let autoConnectMode = false;

// Live accessors handed to feature modules (see core/app-context.ts).
const ctx: AppContext = { getWallet: () => wallet, isRunning: () => isNodeRunning };

// DOM Elements
const startNodeBtn = document.getElementById("start-node-btn") as HTMLButtonElement;
const stopNodeBtn = document.getElementById("stop-node-btn") as HTMLButtonElement;
const autostartCheckbox = document.getElementById("autostart-checkbox") as HTMLInputElement;
const walletStatusBadge = document.getElementById("wallet-status-badge") as HTMLSpanElement;
const seedInput = document.getElementById("seed-input") as HTMLInputElement;
const toggleSeedBtn = document.getElementById("toggle-seed-btn") as HTMLButtonElement;
const copySeedBtn = document.getElementById("copy-seed-btn") as HTMLButtonElement;
const esploraUrlInput = document.getElementById("esplora-url-input") as HTMLInputElement;
const networkSelect = document.getElementById("network-select") as HTMLSelectElement;
const networkBadge = document.getElementById("network-badge") as HTMLSpanElement;
function updateNetworkBadge() { networkBadge.textContent = networkSelect.value; }
updateNetworkBadge();
const wsBridgeUrlInput = document.getElementById("ws-bridge-url") as HTMLInputElement;
const lspConnStrInput = document.getElementById("lsp-conn-str") as HTMLInputElement;
const lspApiUrlInput = document.getElementById("lsp-api-url") as HTMLInputElement;
const nodeIdVal = document.getElementById("node-id-val") as HTMLSpanElement;
const restoreBanner = document.getElementById("restore-banner") as HTMLDivElement;
const balanceSpendableEl = document.getElementById("balance-spendable") as HTMLSpanElement;
const balanceReceivableEl = document.getElementById("balance-receivable") as HTMLSpanElement;
const channelsCountEl = document.getElementById("channels-count") as HTMLSpanElement;
const channelsListEl = document.getElementById("channels-list") as HTMLDivElement;
const gossipStatusEl = document.getElementById("gossip-status") as HTMLSpanElement;
const syncGossipBtn = document.getElementById("sync-gossip-btn") as HTMLButtonElement;

// Per-network defaults: switching the Network selector auto-fills sync/bridge/peer fields.
const NETWORK_PRESETS: Record<string, { esplora: string; bridge: string; peer: string }> = {
  regtest: {
    esplora: "http://127.0.0.1:3002",
    bridge: "ws://127.0.0.1:8091",
    // libre-lnd identity (regenerates if the docker lnd volume is recreated — if
    // Connect Peer fails, refresh via: docker exec libre-lnd lncli getinfo).
    peer: "024228161e3c775fba9255f9253b15cfe12b214113fa7f71b28e42543a14c3ce7d@127.0.0.1:9735",
  },
  signet: {
    esplora: "https://mutinynet.com/api",
    bridge: "ws://127.0.0.1:8083",
    peer: "02465ed5be53d04fde66c9418ff14a5f2267723810176c9212b722e542dc1afb1b@45.79.52.207:9735",
  },
  mainnet: {
    esplora: "https://mempool.space/api",
    // Point at your own LND/CLN node via a local websockify bridge (browser nodes
    // can't dial out directly). Set these in .env.local (gitignored):
    //   VITE_MAINNET_BRIDGE=ws://127.0.0.1:8085
    //   VITE_MAINNET_PEER=<pubkey>@<host>:9735
    bridge: ((import.meta as any).env?.VITE_MAINNET_BRIDGE as string)?.trim() || "",
    peer: ((import.meta as any).env?.VITE_MAINNET_PEER as string)?.trim() || "",
  },
};

networkSelect.addEventListener("change", () => {
  // Network determines which wallet DB we use — switching needs a stopped node.
  if (isNodeRunning) {
    appendLog("[ERROR] Stop the node before switching networks.", "error");
    return;
  }
  const preset = NETWORK_PRESETS[networkSelect.value];
  if (!preset) return;
  esploraUrlInput.value = preset.esplora;
  wsBridgeUrlInput.value = preset.bridge;
  lspConnStrInput.value = preset.peer;
  try { localStorage.setItem("libre_ui_network", networkSelect.value); } catch {}
  updateNetworkBadge();
  appendLog(`[SYSTEM] Network set to ${networkSelect.value}; sync/bridge/peer fields updated.`, "system");
  void refreshWalletForNetwork(networkSelect.value);
});

// Point `storage` at the given network's DB and reflect that wallet in the UI.
// Returns true if that network already has a wallet seed.
async function refreshWalletForNetwork(network: string): Promise<boolean> {
  storage = new IndexedDBStorageProvider(dbNameForNetwork(network));
  await setActiveNetwork(network);
  const storedSeed = await storage.getItem("ldk_seed");
  if (storedSeed && /^[0-9a-fA-F]{64}$/.test(storedSeed)) {
    seedInput.value = storedSeed;
    restoreBanner.classList.add("hidden");
    return true;
  }
  seedInput.value = "";
  restoreBanner.classList.remove("hidden");
  return false;
}

// One-time copy of the legacy un-namespaced `libre-wallet` DB into the correct
// network-scoped DB. Idempotent (localStorage flag + migrateStorage skips a
// non-empty target). Legacy DB is left intact as a fallback.
async function migrateLegacyStorageOnce(selectedNetwork: string): Promise<void> {
  if (localStorage.getItem("libre_ns_migrated") === "1") return;
  try {
    const legacy = new IndexedDBStorageProvider("libre-wallet");
    const legacySeed = await legacy.getItem("ldk_seed");
    if (legacySeed && /^[0-9a-fA-F]{64}$/.test(legacySeed)) {
      let net = selectedNetwork;
      try {
        const cfg = JSON.parse((await legacy.getItem("ldk_config")) || "{}");
        if (cfg && typeof cfg.network === "string") net = cfg.network;
      } catch {}
      const target = new IndexedDBStorageProvider(dbNameForNetwork(net));
      const copied = await migrateStorage(legacy, target);
      appendLog(
        copied > 0
          ? `[SYSTEM] Migrated existing wallet into network storage (libre-wallet-${net}, ${copied} keys).`
          : `[SYSTEM] Existing wallet already present in network storage (libre-wallet-${net}).`,
        "system"
      );
    }
  } catch (e) {
    appendLog(`[WARN] Storage migration skipped: ${e instanceof Error ? e.message : e}`, "warn");
  } finally {
    localStorage.setItem("libre_ns_migrated", "1");
  }
}

// On page load, restore the previously-selected network (+ its preset) and the
// existing wallet seed from storage, so a reload preserves your wallet and network
// instead of resetting to regtest / the default seed (which Start would overwrite).
(async () => {
  try {
    const savedNetwork = localStorage.getItem("libre_ui_network");
    if (savedNetwork && NETWORK_PRESETS[savedNetwork]) {
      networkSelect.value = savedNetwork;
      updateNetworkBadge();
      const preset = NETWORK_PRESETS[savedNetwork];
      esploraUrlInput.value = preset.esplora;
      wsBridgeUrlInput.value = preset.bridge;
      lspConnStrInput.value = preset.peer;
    }
  } catch {}
  const selectedNetwork = networkSelect.value;
  // Assign storage up-front so it's never undefined during the (possibly slow,
  // first-load-only) migration await — a Start click in that window must not throw.
  storage = new IndexedDBStorageProvider(dbNameForNetwork(selectedNetwork));
  await migrateLegacyStorageOnce(selectedNetwork);
  const hasWallet = await refreshWalletForNetwork(selectedNetwork);
  if (hasWallet) {
    appendLog("[SYSTEM] Restored existing wallet seed and network from storage.", "system");
  }

  // Auto-start on load (default on; persisted). A wallet should just run. The
  // off-switch matters because a fresh page firing a full mainnet sync on every
  // reload can trip public-Esplora rate limits (429) — turn it off if that bites.
  const autostart = localStorage.getItem("libre_autostart") !== "0"; // default on
  autostartCheckbox.checked = autostart;
  if (autostart && hasWallet) {
    autoConnectMode = true; // also reconnect the configured peer after start
    appendLog("[SYSTEM] Auto-starting node…", "system");
    startNodeBtn.click();
  }

  tryAutoConnectDrive();
})();

autostartCheckbox.addEventListener("change", () => {
  localStorage.setItem("libre_autostart", autostartCheckbox.checked ? "1" : "0");
});
const peersCountVal = document.getElementById("peers-count") as HTMLSpanElement;

const connectLspBtn = document.getElementById("connect-lsp-btn") as HTMLButtonElement;

const requestJitBtn = document.getElementById("request-jit-btn") as HTMLButtonElement;
const jitAmountInput = document.getElementById("jit-amount") as HTMLInputElement;
const jitDescInput = document.getElementById("jit-desc") as HTMLInputElement;
const jitInvoiceContainer = document.getElementById("jit-invoice-container") as HTMLDivElement;
const jitInvoiceStr = document.getElementById("jit-invoice-str") as HTMLTextAreaElement;
const copyJitInvoiceBtn = document.getElementById("copy-jit-invoice-btn") as HTMLButtonElement;

const purchaseLsps1Btn = document.getElementById("purchase-lsps1-btn") as HTMLButtonElement;
const lsps1AmountInput = document.getElementById("lsps1-amount") as HTMLInputElement;
const lsps1InvoiceContainer = document.getElementById("lsps1-invoice-container") as HTMLDivElement;
const lsps1InvoiceStr = document.getElementById("lsps1-invoice-str") as HTMLTextAreaElement;
const copyLsps1InvoiceBtn = document.getElementById("copy-lsps1-invoice-btn") as HTMLButtonElement;



// Receive (create invoice) Elements
const receiveAmountInput = document.getElementById("receive-amount") as HTMLInputElement;
const receiveDescInput = document.getElementById("receive-desc") as HTMLInputElement;
const createInvoiceBtn = document.getElementById("create-invoice-btn") as HTMLButtonElement;
const receiveInvoiceContainer = document.getElementById("receive-invoice-container") as HTMLDivElement;
const receiveInvoiceStr = document.getElementById("receive-invoice-str") as HTMLTextAreaElement;
const copyReceiveInvoiceBtn = document.getElementById("copy-receive-invoice-btn") as HTMLButtonElement;

// NWC Elements

// Backup & Recovery Elements
const exportStateBtn = document.getElementById("export-state-btn") as HTMLButtonElement;
const importStateFile = document.getElementById("import-state-file") as HTMLInputElement;
const importStateBtn = document.getElementById("import-state-btn") as HTMLButtonElement;
const newWalletBtn = document.getElementById("new-wallet-btn") as HTMLButtonElement;
const backupStatusEl = document.getElementById("backup-status") as HTMLSpanElement;
const connectDriveBtn = document.getElementById("connect-drive-btn") as HTMLButtonElement;
const backupDriveNowBtn = document.getElementById("backup-drive-now-btn") as HTMLButtonElement;
const driveStatusEl = document.getElementById("drive-status") as HTMLSpanElement;
const restoreDriveBtn = document.getElementById("restore-drive-btn") as HTMLButtonElement;
const createWalletFields = document.getElementById("create-wallet-fields") as HTMLDivElement;
const seedSavedCheckbox = document.getElementById("seed-saved-checkbox") as HTMLInputElement;
const createWalletBtn = document.getElementById("create-wallet-btn") as HTMLButtonElement;
const createWalletStatus = document.getElementById("create-wallet-status") as HTMLSpanElement;

let driveSyncTimer: any = null;
let driveSyncing = false;
function loadDriveSyncedVersion(): number {
  const s = localStorage.getItem(`libre_drive_synced_version_${networkSelect.value}`);
  const n = s === null ? NaN : parseInt(s, 10);
  return Number.isNaN(n) ? -1 : n;
}
// Baked-in OAuth Client ID (set VITE_GOOGLE_CLIENT_ID in packages/example-app/.env.local).
// Falls back to the paste field when not configured.
const BAKED_CLIENT_ID =
  ((import.meta as any).env?.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || "";
function resolveClientId(): string {
  return BAKED_CLIENT_ID;
}



// Helper to extract hex node id from byte array
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 5. Setup Action Listeners
toggleSeedBtn.addEventListener("click", () => {
  if (seedInput.type === "password") {
    seedInput.type = "text";
    toggleSeedBtn.innerText = "Hide";
  } else {
    seedInput.type = "password";
    toggleSeedBtn.innerText = "Show";
  }
});

initLogControls();

// 6. Start LDK Node
// Renders balance + channel list with connected/active status. Safe to call any time.
function refreshWalletView(): void {
  try {
    if (!wallet || !isNodeRunning) {
      balanceSpendableEl.textContent = "0 sats";
      balanceReceivableEl.textContent = "0 sats";
      channelsCountEl.textContent = "0";
      channelsListEl.textContent = "No channels yet";
      return;
    }
    const bal = wallet.getBalance();
    const chans = wallet.getChannels();
    balanceSpendableEl.textContent = `${bal.spendableSat} sats`;
    balanceReceivableEl.textContent = `${bal.receivableSat} sats`;
    channelsCountEl.textContent = String(chans.length);
    if (chans.length === 0) {
      channelsListEl.textContent = "No channels yet";
      return;
    }
    channelsListEl.innerHTML = chans
      .map((c) => {
        const badge = c.isUsable
          ? '<span style="color:#22c55e">● active</span>'
          : c.isChannelReady
          ? '<span style="color:#f59e0b">● ready (peer offline)</span>'
          : '<span style="color:#9ca3af">● pending</span>';
        return `<div class="status-line"><span class="value">${c.channelId.slice(0, 8)}… ${badge}</span>` +
          `<span class="value">cap ${c.capacitySat} · send ${c.outboundSendableSat} / recv ${c.inboundSat}</span></div>`;
      })
      .join("");
  } catch (e) {
    appendLog(`[WARN] refreshWalletView failed: ${e instanceof Error ? e.message : e}`, "warn");
  }
}

// Show how many channels the routing graph holds. Multi-hop sends (v4vmusic boosts
// to arbitrary artists) need a populated graph; a count near zero means routing will
// fail and the user should Sync gossip first.
function renderGraphStatus(): void {
  if (!wallet || !isNodeRunning) {
    gossipStatusEl.textContent = "Graph: 0 channels";
    return;
  }
  try {
    const ng = wallet.getNetworkGraph();
    if (!ng) {
      gossipStatusEl.textContent = "Graph: unavailable";
      return;
    }
    const readOnly = ng.read_only();
    const count = readOnly.list_channels().length;
    readOnly.free(); // ReadOnlyNetworkGraph holds a read lock that must be freed.
    gossipStatusEl.textContent = `Graph: ${count.toLocaleString()} channels`;
  } catch (e) {
    gossipStatusEl.textContent = "Graph: unavailable";
    appendLog(`[WARN] renderGraphStatus failed: ${e instanceof Error ? e.message : e}`, "warn");
  }
}

// Fetch a Rapid Gossip Sync snapshot (via the CORS proxy) and refresh the readout.
// No-op on non-mainnet (no RGS URL ⇒ syncGossip returns immediately).
async function syncGossipAndRender(): Promise<void> {
  if (!wallet || !isNodeRunning) return;
  try {
    syncGossipBtn.disabled = true;
    gossipStatusEl.textContent = "Syncing gossip…";
    await wallet.syncGossip();
    renderGraphStatus();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendLog(`[WARN] Gossip sync failed: ${msg}`, "warn");
    gossipStatusEl.textContent = `Sync failed: ${msg}`;
  } finally {
    if (wallet && isNodeRunning) syncGossipBtn.disabled = false;
  }
}

syncGossipBtn.addEventListener("click", () => {
  void syncGossipAndRender();
});

startNodeBtn.addEventListener("click", async () => {
  try {
    // A seed was generated via Create New Wallet but the wallet hasn't been
    // created yet. Don't let Start bypass the save-seed step.
    if (pendingSeed) {
      appendLog(
        "[ERROR] Finish creating your wallet first: tick ‘I've saved my recovery seed’ and click ‘Create Wallet’. " +
          "(Reload the page to cancel.)",
        "error"
      );
      return;
    }
    startNodeBtn.disabled = true;
    appendLog("[SYSTEM] Initializing LibreListenerWallet...", "system");
    appendLog("[SYSTEM] Fetching and compiling LDK WebAssembly...", "system");

    // Resolve the seed: prefer the field (manual entry / New Wallet), else fall
    // back to the seed already in storage (e.g. after a passphrase-only restore).
    let seed = seedInput.value.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
      const stored = await storage.getItem("ldk_seed");
      if (stored && /^[0-9a-fA-F]{64}$/.test(stored)) {
        seed = stored;
        seedInput.value = stored;
      } else {
        throw new Error("No wallet seed found. Create a New Wallet or restore a backup first.");
      }
    }
    await storage.setItem("ldk_seed", seed);

    const esploraUrl = esploraUrlInput.value.trim();
    const selectedNetwork = networkSelect.value as "mainnet" | "testnet" | "regtest" | "signet";

    // Save current config to storage so SW can read it
    const ldkConfig = { network: selectedNetwork, esploraUrl };
    await storage.setItem("ldk_config", JSON.stringify(ldkConfig));
    await setActiveNetwork(selectedNetwork);

    // Do NOT auto-trust any peer for 0-conf. Accepting a channel 0-conf
    // (min_depth 0) when the LSP opened it non-zero-conf makes lnd reject the
    // open ("non-zero-conf channel has min depth zero"). Current LSPs open
    // CONFIRMED channels — the regtest onboarding server opens a non-anchor
    // channel and mines to confirm; Mutinynet advertises ZeroConf: not supported.
    // So the listener accepts a normal confirmed channel. (True 0-conf JIT would
    // require an anchor channel + an LSP that signals zeroconf, and on real
    // networks the fee negotiation works — that's a future addition.)
    const trustedZeroConfPeers: string[] = [];

    wallet = new LibreListenerWallet({
      config: {
        network: selectedNetwork,
        esploraUrl,
        trustedZeroConfPeers,
        // Rapid Gossip Sync populates the network graph so the router can find
        // multi-hop routes (e.g. a v4vmusic boost to an arbitrary artist). The LDK
        // RGS server is CORS-blocked in the browser, so VITE_MAINNET_RGS must point
        // at a CORS-enabled proxy (the push gateway's /rgs/snapshot route). Mainnet-only.
        rapidGossipSyncUrl: rgsUrlForNetwork(
          selectedNetwork,
          (import.meta as any).env?.VITE_MAINNET_RGS as string | undefined
        ),
        // Public channels on real networks (e.g. accepting the Mutinynet faucet's
        // announced channel); private on regtest where our LND opens --private.
        announceChannels: selectedNetwork !== "regtest",
        // Broadcast a node name so peers show it instead of "Unknown" (only
        // propagates once a public channel is announced).
        alias: "Libre Listener Wallet",
      },
      storage,
      socketProvider: new BrowserWebSocketStreamProvider(),
      wasmUrl: "/liblightningjs.wasm",
      logger: {
        info: (msg: string, ...args: any[]) => {
          console.log(msg, ...args);
          if (msg.startsWith("[LDK]")) {
            if (msg.includes("[TRACE]")) appendLog(msg, "ldk-trace");
            else if (msg.includes("[DEBUG]")) appendLog(msg, "ldk-debug");
            else appendLog(msg, "ldk-info");
          } else {
            appendLog(msg, "info");
          }
        },
        warn: (msg: string, ...args: any[]) => {
          console.warn(msg, ...args);
          appendLog(msg, "warn");
        },
        error: (msg: string, ...args: any[]) => {
          console.error(msg, ...args);
          appendLog(msg, "error");
        },
      },
    });

    // Handle incoming LDK Events
    wallet.addEventListener((event: any) => {
      const name = event.constructor.name;
      appendLog(`[LDK EVENT] Event fired: ${name}`, "system");
      
      // Update peers list status
      if (wallet) {
        const peers = wallet.getConnectedPeers();
        peersCountVal.innerText = peers.length.toString();
      }
      refreshWalletView();
    });

    await wallet.start();
    isNodeRunning = true;
    // Event-driven backup status + Drive auto-sync (replaces 2s polling).
    wallet.onStateChanged(onWalletStateChanged);
    onWalletStateChanged();
    refreshWalletView();
    if (walletViewTimer) clearInterval(walletViewTimer);
    walletViewTimer = setInterval(refreshWalletView, 5000);
    syncGossipBtn.disabled = false;
    renderGraphStatus();
    // Warm the routing graph in the background so multi-hop sends can find a route.
    // No-op off mainnet (no RGS URL configured).
    void syncGossipAndRender();
    appendLog("[SYSTEM] LDK Node running successfully!", "system");

    // Update UI Status
    walletStatusBadge.innerText = "Running";
    walletStatusBadge.className = "badge badge-status running";
    stopNodeBtn.disabled = false;
    networkSelect.disabled = true;
    connectLspBtn.disabled = false;
    requestJitBtn.disabled = false;
    purchaseLsps1Btn.disabled = false;
    setV4VEnabled(true);
    createInvoiceBtn.disabled = false;
    setNwcEnabled(true);
    exportStateBtn.disabled = false;
    newWalletBtn.disabled = true;
    await updateNwcConnectionsList();

    // For a freshly created wallet, best-effort sync + verify the backup to Drive.
    if (justCreated) {
      justCreated = false;
      await createAndVerifyBackup();
    }


    // Display Node ID
    const mgr = wallet.getChannelManager();
    if (mgr) {
      const nodeId = bytesToHex(mgr.get_our_node_id());
      nodeIdVal.innerText = nodeId;
    }

    // When auto-started on load, also auto-connect the configured peer.
    if (autoConnectMode) {
      autoConnectMode = false;
      if (lspConnStrInput.value.trim().includes("@")) {
        appendLog("[SYSTEM] Auto-connecting to peer…", "system");
        connectLspBtn.click();
      }
    }
  } catch (err: any) {
    appendLog(`[ERROR] Start failed: ${err.message}`, "error");
    startNodeBtn.disabled = false;
    // Don't leak post-start intents into a later manual Start if this one failed.
    justCreated = false;
    autoConnectMode = false;
  }
});

// 7. Stop LDK Node
stopNodeBtn.addEventListener("click", async () => {
  if (!wallet || !isNodeRunning) return;
  try {
    stopNodeBtn.disabled = true;
    appendLog("[SYSTEM] Shutting down LDK Node...", "system");
    // Cancel any debounced Drive upload so it can't fire after teardown.
    if (driveSyncTimer) {
      clearTimeout(driveSyncTimer);
      driveSyncTimer = null;
    }
    await wallet.stop();
    isNodeRunning = false;
    wallet = null;

    appendLog("[SYSTEM] LDK Node stopped.", "system");

    // Reset UI
    walletStatusBadge.innerText = "Stopped";
    walletStatusBadge.className = "badge badge-status stopped";
    startNodeBtn.disabled = false;
    stopNodeBtn.disabled = true;
    networkSelect.disabled = false;
    connectLspBtn.disabled = true;
    requestJitBtn.disabled = true;
    purchaseLsps1Btn.disabled = true;
    setV4VEnabled(false);
    setNwcEnabled(false);
    exportStateBtn.disabled = true;
    newWalletBtn.disabled = false;
    nodeIdVal.innerText = "-";
    peersCountVal.innerText = "0";
    if (walletViewTimer) {
      clearInterval(walletViewTimer);
      walletViewTimer = null;
    }
    refreshWalletView(); // renders zeros / "No channels yet"
    syncGossipBtn.disabled = true;
    renderGraphStatus();
    jitInvoiceContainer.classList.add("hidden");
    lsps1InvoiceContainer.classList.add("hidden");


  } catch (err: any) {
    appendLog(`[ERROR] Stop failed: ${err.message}`, "error");
    stopNodeBtn.disabled = false;
  }
});

// 8. Connect Peer
connectLspBtn.addEventListener("click", async () => {
  if (!wallet || !isNodeRunning) return;
  try {
    connectLspBtn.disabled = true;
    const connStr = lspConnStrInput.value.trim();
    if (!connStr.includes("@") || !connStr.includes(":")) {
      throw new Error("LSP connection string must be in pubkey@host:port format");
    }

    const [pubkey, addressPort] = connStr.split("@");
    const [host, portStr] = addressPort.split(":");
    const port = parseInt(portStr, 10);

    appendLog(`[SYSTEM] Connecting to peer ${pubkey}...`, "system");
    await wallet.connectPeer(pubkey, host, port);
    
    appendLog(`[SYSTEM] Peer connected!`, "system");
    
    // Update peer count
    if (wallet) {
      const peers = wallet.getConnectedPeers();
      peersCountVal.innerText = peers.length.toString();
    }
  } catch (err: any) {
    appendLog(`[ERROR] Peer connection failed: ${err.message}`, "error");
  } finally {
    connectLspBtn.disabled = false;
  }
});

// 9. Request LSPS2 JIT Invoice
requestJitBtn.addEventListener("click", async () => {
  if (!wallet || !isNodeRunning) return;
  try {
    requestJitBtn.disabled = true;
    jitInvoiceContainer.classList.add("hidden");

    const amountSats = parseInt(jitAmountInput.value, 10);
    const description = jitDescInput.value.trim();
    const lspConnStr = lspConnStrInput.value.trim();
    const [lspPubkey] = lspConnStr.split("@");

    const lsp = {
      name: "libre-lsp",
      pubkey: lspPubkey,
      connection_string: lspConnStr,
      api_url: lspApiUrlInput.value.trim(),
      protocols: ["lsps2" as const],
    };

    appendLog(`[LSPS2] Initiating JIT invoice request for ${amountSats} sats...`, "system");
    const invoice = await wallet.requestLSPS2Invoice({
      amountSats,
      description,
      lsp,
    });

    appendLog(`[LSPS2] Invoice received: ${invoice.substring(0, 30)}...`, "system");
    jitInvoiceStr.value = invoice;
    jitInvoiceContainer.classList.remove("hidden");
  } catch (err: any) {
    appendLog(`[ERROR] LSPS2 request failed: ${err.message}`, "error");
  } finally {
    requestJitBtn.disabled = false;
  }
});

copyJitInvoiceBtn.addEventListener("click", () => copyToClipboard(jitInvoiceStr.value, "JIT Invoice copied to clipboard."));

createInvoiceBtn.addEventListener("click", async () => {
  if (!wallet || !isNodeRunning) return;
  try {
    createInvoiceBtn.disabled = true;
    const amount = parseInt(receiveAmountInput.value, 10);
    const desc = receiveDescInput.value.trim() || "Libre Listener Wallet";
    appendLog(`[Receive] Creating BOLT11 invoice for ${amount} sats...`, "system");
    const invoice = await wallet.createInvoice(amount, desc);
    receiveInvoiceStr.value = invoice;
    receiveInvoiceContainer.classList.remove("hidden");
    appendLog(`[Receive] Invoice created — pay it from your channel peer to fund the wallet.`, "system");
  } catch (err) {
    appendLog(`[ERROR] Failed to create invoice: ${err instanceof Error ? err.message : err}`, "error");
  } finally {
    createInvoiceBtn.disabled = false;
  }
});

copyReceiveInvoiceBtn.addEventListener("click", () => copyToClipboard(receiveInvoiceStr.value, "Invoice copied to clipboard."));

// 10. Purchase LSPS1 Capacity
purchaseLsps1Btn.addEventListener("click", async () => {
  if (!wallet || !isNodeRunning) return;
  try {
    purchaseLsps1Btn.disabled = true;
    lsps1InvoiceContainer.classList.add("hidden");

    const amountSats = parseInt(lsps1AmountInput.value, 10);
    const lspConnStr = lspConnStrInput.value.trim();
    const [lspPubkey] = lspConnStr.split("@");

    const lsp = {
      name: "libre-lsp",
      pubkey: lspPubkey,
      connection_string: lspConnStr,
      api_url: lspApiUrlInput.value.trim().replace("/lsps2", "/lsps1"), // Fallback LSPS1 api endpoint
      protocols: ["lsps1" as const],
    };

    appendLog(`[LSPS1] Purchasing ${amountSats} sats inbound capacity...`, "system");
    const invoice = await wallet.purchaseLSPS1Capacity({
      amountSats,
      lsp,
    });

    appendLog(`[LSPS1] Order placed! Pay invoice: ${invoice.substring(0, 30)}...`, "system");
    lsps1InvoiceStr.value = invoice;
    lsps1InvoiceContainer.classList.remove("hidden");
  } catch (err: any) {
    appendLog(`[ERROR] LSPS1 purchase failed: ${err.message}`, "error");
  } finally {
    purchaseLsps1Btn.disabled = false;
  }
});

copyLsps1InvoiceBtn.addEventListener("click", () => copyToClipboard(lsps1InvoiceStr.value, "LSPS1 Invoice copied to clipboard."));




initV4V(ctx);
initNwcUi(ctx);
initWebPush(ctx);

// Backup & Recovery Handlers
exportStateBtn.addEventListener("click", async () => {
  if (!wallet) {
    appendLog("[ERROR] Start the node before exporting.", "error");
    return;
  }
  try {
    const blob = await wallet.exportState();
    const url = URL.createObjectURL(new Blob([blob], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `libre-wallet-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    localStorage.setItem(`libre_last_backup_version_${networkSelect.value}`, String(wallet.getStateVersion()));
    refreshBackupStatus();
    appendLog("[SYSTEM] Encrypted backup downloaded. Keep it and your seed safe.", "system");
  } catch (e) {
    appendLog(`[ERROR] Export failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});

importStateBtn.addEventListener("click", async () => {
  const file = importStateFile.files?.[0];
  if (!file) {
    appendLog("[ERROR] Choose a backup file first.", "error");
    return;
  }
  const seed = seedInput.value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
    appendLog("[ERROR] Paste your 64-hex seed in the Seed field to decrypt the backup.", "error");
    return;
  }
  try {
    const blob = await file.text();
    const importWallet = new LibreListenerWallet({
      config: {
        network: networkSelect.value as "mainnet" | "testnet" | "regtest" | "signet",
        esploraUrl: esploraUrlInput.value.trim(),
      },
      storage,
      socketProvider: new BrowserWebSocketStreamProvider(),
      wasmUrl: "/liblightningjs.wasm",
    });
    await importWallet.importState(blob, seed);
    appendLog("[SYSTEM] Backup restored to storage. Click Start Node to boot the recovered wallet.", "system");
  } catch (e) {
    appendLog(`[ERROR] Restore failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});

// Enable "Create Wallet" once the user confirms they saved the seed.
function updateCreateWalletBtnState(): void {
  createWalletBtn.disabled = !seedSavedCheckbox.checked;
}
seedSavedCheckbox.addEventListener("change", updateCreateWalletBtnState);

// Step 1 — "Create New Wallet": generate + reveal a fresh seed and show the
// "I saved it" panel. No state is written yet.
newWalletBtn.addEventListener("click", async () => {
  if (isNodeRunning) {
    appendLog("[ERROR] Stop the node before creating a new wallet.", "error");
    return;
  }
  // Best-effort durable storage (warn, don't block — persist() is false on plain
  // localhost windows too; the saved seed is the real safety net).
  if (!(await ensurePersistentStorage())) {
    appendLog(
      "[WARN] Browser did not grant persistent storage. In a normal window your data still survives; in a " +
        "private/Incognito window it is WIPED when the window closes. Save your seed!",
      "warn"
    );
  }
  const seedBytes = new Uint8Array(32);
  crypto.getRandomValues(seedBytes);
  pendingSeed = Array.from(seedBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  seedInput.value = pendingSeed;
  seedInput.type = "text"; // reveal so they can copy it
  seedSavedCheckbox.checked = false;
  updateCreateWalletBtnState();
  createWalletFields.classList.remove("hidden");
  createWalletStatus.textContent = "Save the seed above, tick the box, then Create Wallet";
  appendLog("[SYSTEM] New seed generated and shown above. SAVE IT NOW (paper/password manager), then tick the box.", "system");
});

// Step 2 — "Create Wallet": persist the new wallet, then start the node (which
// best-effort syncs + verifies the seed-encrypted backup to Drive).
createWalletBtn.addEventListener("click", async () => {
  if (!pendingSeed) {
    appendLog("[ERROR] Click ‘Create New Wallet’ first to generate a seed.", "error");
    return;
  }
  if (!seedSavedCheckbox.checked) {
    appendLog("[ERROR] Confirm you saved the seed first.", "error");
    return;
  }
  try {
    const existing = await storage.getItem("ldk_seed");
    if (
      existing &&
      !window.confirm("Replace the wallet in this browser? Make sure you have a backup of the current one first.")
    ) {
      // Abort cleanly: drop the unsaved new seed, restore the field to the real
      // wallet seed, and hide the panel so Start isn't blocked by pendingSeed.
      pendingSeed = null;
      seedInput.value = existing;
      seedSavedCheckbox.checked = false;
      createWalletFields.classList.add("hidden");
      createWalletStatus.textContent = "—";
      appendLog("[SYSTEM] New wallet cancelled — existing wallet kept.", "system");
      return;
    }
    await storage.clear();
    await storage.setItem("ldk_seed", pendingSeed);
    pendingSeed = null; // consumed
    justCreated = true;
    autoConnectMode = true; // also connect the configured peer after start (mirrors auto-start path)
    createWalletFields.classList.add("hidden");
    nodeIdVal.innerText = "-";
    createWalletStatus.textContent = "Wallet created — starting node…";
    appendLog("[SYSTEM] Wallet created. Starting node…", "system");
    startNodeBtn.click(); // auto-start → best-effort Drive backup because justCreated is set
  } catch (e) {
    appendLog(`[ERROR] Create wallet failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});

// Reflect whether the on-disk backup file is current vs. the wallet's channel state.
function refreshBackupStatus() {
  if (!wallet || !isNodeRunning) {
    backupStatusEl.textContent = "—";
    backupStatusEl.className = "value";
    return;
  }
  const current = wallet.getStateVersion();
  const lastStr = localStorage.getItem(`libre_last_backup_version_${networkSelect.value}`);
  const parsed = lastStr === null ? NaN : parseInt(lastStr, 10);
  const last = Number.isNaN(parsed) ? -1 : parsed;
  if (last < 0) {
    backupStatusEl.textContent = "No backup yet — click Download";
    backupStatusEl.className = "value text-warning";
  } else if (current > last) {
    backupStatusEl.textContent = "⚠️ Out of date — click Download";
    backupStatusEl.className = "value text-warning";
  } else {
    backupStatusEl.textContent = "Up to date ✓";
    backupStatusEl.className = "value";
  }
}
// Fired by wallet.onStateChanged (registered on node start) — no polling. Refreshes the
// backup indicator and debounces a Drive auto-upload when channel state advances.
function onWalletStateChanged(): void {
  refreshBackupStatus();
  refreshWalletView();
  if (!wallet || !isNodeRunning || !drive.isConnected() || driveSyncing) return;
  if (wallet.getStateVersion() > loadDriveSyncedVersion()) {
    if (driveSyncTimer) clearTimeout(driveSyncTimer);
    driveSyncTimer = setTimeout(() => {
      driveSyncTimer = null;
      void uploadBackupToDrive();
    }, 5000);
  }
}

// On (re)connecting Drive, push immediately if channel state advanced while we were
// disconnected — so a state change is never left un-backed-up.
function maybeCatchUpDriveSync(): void {
  if (wallet && isNodeRunning && drive.isConnected() && !driveSyncing && wallet.getStateVersion() > loadDriveSyncedVersion()) {
    void uploadBackupToDrive();
  }
}

copySeedBtn.addEventListener("click", async () => {
  const seed = seedInput.value.trim();
  if (seed.length !== 64) {
    appendLog("[ERROR] No 64-char seed to copy.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(seed);
    appendLog("[SYSTEM] Seed copied to clipboard — store it somewhere safe.", "system");
  } catch (e) {
    appendLog(`[ERROR] Copy failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});

// --- Google Drive backup ---
function updateDriveStatus(text?: string) {
  if (text) {
    driveStatusEl.textContent = text;
  } else {
    driveStatusEl.textContent = drive.isConnected() ? "connected ✓" : "not connected";
  }
}

// Connect Drive, feeding the remembered account email as a login_hint so a silent
// reconnect on a later load reuses the existing session without a popup. Persists the
// email after a successful connect for next time. All three connect sites go through this.
const DRIVE_HINT_KEY = "libre_drive_hint";
async function connectDrive(clientId: string, opts: { silent?: boolean } = {}): Promise<void> {
  const hint = localStorage.getItem(DRIVE_HINT_KEY) || undefined;
  await drive.connect(clientId, { ...opts, hint });
  const email = drive.getConnectedEmail();
  if (email) localStorage.setItem(DRIVE_HINT_KEY, email);
}

// Client ID is baked in via VITE_GOOGLE_CLIENT_ID (.env.local). If it's missing,
// connect will report it rather than offering a paste field.
updateDriveStatus();

connectDriveBtn.addEventListener("click", async () => {
  const clientId = resolveClientId();
  if (!clientId) {
    appendLog("[ERROR] No Google OAuth Client ID configured — set VITE_GOOGLE_CLIENT_ID in packages/example-app/.env.local.", "error");
    return;
  }
  try {
    updateDriveStatus("connecting…");
    await connectDrive(clientId);
    updateDriveStatus();
    appendLog("[SYSTEM] Connected to Google Drive.", "system");
    maybeCatchUpDriveSync();
  } catch (e) {
    updateDriveStatus("not connected");
    appendLog(`[ERROR] Google Drive connect failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});

// Attempt a silent (no-popup) Google Drive re-auth on page load. Succeeds if the user
// has an active Google session + prior consent; otherwise leaves the manual button.
async function tryAutoConnectDrive(): Promise<void> {
  const clientId = resolveClientId();
  if (!clientId) return;
  try {
    updateDriveStatus("connecting…");
    await connectDrive(clientId, { silent: true });
    updateDriveStatus();
    appendLog("[SYSTEM] Auto-connected to Google Drive.", "system");
    maybeCatchUpDriveSync();
  } catch {
    updateDriveStatus("not connected");
    appendLog("[SYSTEM] Google Drive: silent reconnect unavailable — click Connect Drive.", "system");
  }
}

// Best-effort: if Drive is connected, sync the seed-encrypted backup and verify
// it re-downloads + decrypts with the seed. Non-blocking — the seed itself is the
// primary recovery, so a missing Drive connection just prints a reminder.
async function createAndVerifyBackup(): Promise<void> {
  if (!wallet) return;
  const seedHex = (await storage.getItem("ldk_seed")) || "";
  try {
    if (!drive.isConnected()) {
      appendLog("[SYSTEM] Tip: Connect Google Drive to store an encrypted backup of your channel state.", "system");
      createWalletStatus.textContent = "Wallet running — connect Drive to back up channel state";
      return;
    }
    const env = await wallet.exportState();
    await drive.uploadBackup(env, networkSelect.value);
    const redown = await drive.downloadBackup(networkSelect.value);
    if (!redown) {
      appendLog("[WARN] Backup not found in Drive after upload. Your seed is your recovery — keep it safe.", "warn");
      createWalletStatus.textContent = "⚠️ Drive backup not verified — keep your seed";
      return;
    }
    const res = await wallet.verifyBackup(redown, seedHex);
    if (res.ok && res.hasSeed && res.seedMatches !== false) {
      localStorage.setItem(`libre_drive_synced_version_${networkSelect.value}`, String(wallet.getStateVersion()));
      appendLog("[SYSTEM] ✅ Backup synced to Drive & verified restorable with your seed.", "system");
      createWalletStatus.textContent = "✅ Backup verified on Drive";
    } else {
      appendLog(`[WARN] Drive backup not verified (${res.error ?? "mismatch"}). Your seed is still your recovery — keep it safe.`, "warn");
      createWalletStatus.textContent = "⚠️ Drive backup not verified — keep your seed";
    }
  } catch (e) {
    appendLog(`[WARN] Drive backup step failed: ${e instanceof Error ? e.message : e}. Your seed is your recovery — keep it safe.`, "warn");
  }
}

async function uploadBackupToDrive(): Promise<void> {
  if (!wallet || !isNodeRunning) {
    appendLog("[ERROR] Start the node before backing up to Drive.", "error");
    return;
  }
  if (!drive.isConnected()) {
    appendLog("[ERROR] Connect Google Drive first.", "error");
    return;
  }
  driveSyncing = true;
  updateDriveStatus("syncing…");
  try {
    const version = wallet.getStateVersion();
    await drive.uploadBackup(await wallet.exportState(), networkSelect.value);
    localStorage.setItem(`libre_drive_synced_version_${networkSelect.value}`, String(version));
    updateDriveStatus(`synced ✓ (v${version})`);
    appendLog(`[SYSTEM] Backup synced to Google Drive (v${version}).`, "system");
  } catch (e) {
    if (e instanceof drive.DriveReconnectError) {
      updateDriveStatus("reconnect needed");
      appendLog("[ERROR] Google Drive session expired — click Connect again.", "error");
    } else {
      updateDriveStatus("connected ✓");
      appendLog(`[ERROR] Drive sync failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  } finally {
    driveSyncing = false;
  }
}

backupDriveNowBtn.addEventListener("click", () => {
  void uploadBackupToDrive();
});


restoreDriveBtn.addEventListener("click", async () => {
  const seed = seedInput.value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
    appendLog("[ERROR] Paste your 64-hex seed in the Seed field to decrypt the Drive backup.", "error");
    return;
  }
  try {
    if (!drive.isConnected()) {
      const clientId = resolveClientId();
      if (!clientId) {
        appendLog("[ERROR] No Google OAuth Client ID configured — set VITE_GOOGLE_CLIENT_ID in .env.local.", "error");
        return;
      }
      await connectDrive(clientId);
      updateDriveStatus();
    }
    const blob = await drive.downloadBackup(networkSelect.value);
    if (!blob) {
      appendLog("[SYSTEM] No backup found in your Google Drive.", "system");
      return;
    }
    const importWallet = new LibreListenerWallet({
      config: {
        network: networkSelect.value as "mainnet" | "testnet" | "regtest" | "signet",
        esploraUrl: esploraUrlInput.value.trim(),
      },
      storage,
      socketProvider: new BrowserWebSocketStreamProvider(),
      wasmUrl: "/liblightningjs.wasm",
    });
    await importWallet.importState(blob, seed);
    appendLog("[SYSTEM] Backup restored from Google Drive. Click Start Node to boot the recovered wallet.", "system");
  } catch (e) {
    appendLog(`[ERROR] Restore from Drive failed: ${e instanceof Error ? e.message : e}`, "error");
  }
});

