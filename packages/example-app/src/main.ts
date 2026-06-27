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
    // Bridge browser WebSocket to LND TCP port 9735 via websockify at 127.0.0.1:8081
    const wsUrl =
      (document.getElementById("ws-bridge-url") as HTMLInputElement | null)?.value?.trim() ||
      "ws://127.0.0.1:8081";
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
const storage = new IndexedDBStorageProvider();

// 3. Logger helper to update UI terminal console
// 4. Wallet Lifecycle State
let wallet: LibreListenerWallet | null = null;
let isNodeRunning = false;
// Set when the wallet is auto-started on page load, so the start handler knows to
// also auto-connect the peer once the node is running.
let autoConnectMode = false;

// Live accessors handed to feature modules (see core/app-context.ts).
const ctx: AppContext = { getWallet: () => wallet, isRunning: () => isNodeRunning };

// DOM Elements
const startNodeBtn = document.getElementById("start-node-btn") as HTMLButtonElement;
const stopNodeBtn = document.getElementById("stop-node-btn") as HTMLButtonElement;
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

// Per-network defaults: switching the Network selector auto-fills sync/bridge/peer fields.
const NETWORK_PRESETS: Record<string, { esplora: string; bridge: string; peer: string }> = {
  regtest: {
    esplora: "http://127.0.0.1:3002",
    bridge: "ws://127.0.0.1:8081",
    peer: "02cee2811b196ef8e7e3beddcf4d9bee63eb4e9edc5c9b9ce211075a90bd0be397@127.0.0.1:9735",
  },
  signet: {
    esplora: "https://mutinynet.com/api",
    bridge: "ws://127.0.0.1:8083",
    peer: "02465ed5be53d04fde66c9418ff14a5f2267723810176c9212b722e542dc1afb1b@45.79.52.207:9735",
  },
  mainnet: {
    esplora: "https://blockstream.info/api",
    // Point at your own LND/CLN node via a local websockify bridge (browser nodes
    // can't dial out directly). Set these in .env.local (gitignored):
    //   VITE_MAINNET_BRIDGE=ws://127.0.0.1:8085
    //   VITE_MAINNET_PEER=<pubkey>@<host>:9735
    bridge: ((import.meta as any).env?.VITE_MAINNET_BRIDGE as string)?.trim() || "",
    peer: ((import.meta as any).env?.VITE_MAINNET_PEER as string)?.trim() || "",
  },
};

networkSelect.addEventListener("change", () => {
  const preset = NETWORK_PRESETS[networkSelect.value];
  if (!preset) return;
  esploraUrlInput.value = preset.esplora;
  wsBridgeUrlInput.value = preset.bridge;
  lspConnStrInput.value = preset.peer;
  try { localStorage.setItem("libre_ui_network", networkSelect.value); } catch {}
  updateNetworkBadge();
  appendLog(`[SYSTEM] Network set to ${networkSelect.value}; sync/bridge/peer fields updated.`, "system");
});

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
  try {
    const storedSeed = await storage.getItem("ldk_seed");
    if (storedSeed && /^[0-9a-fA-F]{64}$/.test(storedSeed)) {
      seedInput.value = storedSeed;
      restoreBanner.classList.add("hidden");
      appendLog("[SYSTEM] Restored existing wallet seed and network from storage.", "system");
    } else {
      // Fresh/wiped browser — guide the user to restore from their backup file.
      restoreBanner.classList.remove("hidden");
    }
  } catch {}

  // Auto-start on load is intentionally disabled: a fresh page firing a full mainnet
  // sync on every reload trips public-Esplora rate limits (429 Too Many Requests).
  // Click Start manually instead. (Drive still silently re-auths — that's harmless.)
  tryAutoConnectDrive();
})();
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

let driveSyncTimer: any = null;
let driveSyncing = false;
function loadDriveSyncedVersion(): number {
  const s = localStorage.getItem("libre_drive_synced_version");
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
startNodeBtn.addEventListener("click", async () => {
  try {
    startNodeBtn.disabled = true;
    appendLog("[SYSTEM] Initializing LibreListenerWallet...", "system");
    appendLog("[SYSTEM] Fetching and compiling LDK WebAssembly...", "system");

    // Save custom seed to localStorage before start
    const seed = seedInput.value.trim();
    if (seed.length !== 64) {
      throw new Error("Seed must be a 32-byte hex string (64 characters)");
    }
    await storage.setItem("ldk_seed", seed);

    const esploraUrl = esploraUrlInput.value.trim();
    const selectedNetwork = networkSelect.value as "mainnet" | "testnet" | "regtest" | "signet";

    // Save current config to storage so SW can read it
    const ldkConfig = { network: selectedNetwork, esploraUrl };
    await storage.setItem("ldk_config", JSON.stringify(ldkConfig));

    wallet = new LibreListenerWallet({
      config: {
        network: selectedNetwork,
        esploraUrl,
        // Rapid Gossip Sync is disabled in-browser: the LDK RGS server
        // (rapidsync.lightningdevkit.org) sends no CORS headers, so a browser fetch is
        // blocked. Works from Node; in-browser use needs a CORS-enabled RGS proxy.
        rapidGossipSyncUrl: undefined,
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
    });

    await wallet.start();
    isNodeRunning = true;
    // Event-driven backup status + Drive auto-sync (replaces 2s polling).
    wallet.onStateChanged(onWalletStateChanged);
    onWalletStateChanged();
    appendLog("[SYSTEM] LDK Node running successfully!", "system");

    // Update UI Status
    walletStatusBadge.innerText = "Running";
    walletStatusBadge.className = "badge badge-status running";
    stopNodeBtn.disabled = false;
    connectLspBtn.disabled = false;
    requestJitBtn.disabled = false;
    purchaseLsps1Btn.disabled = false;
    setV4VEnabled(true);
    createInvoiceBtn.disabled = false;
    setNwcEnabled(true);
    exportStateBtn.disabled = false;
    newWalletBtn.disabled = true;
    await updateNwcConnectionsList();


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
  }
});

// 7. Stop LDK Node
stopNodeBtn.addEventListener("click", async () => {
  if (!wallet || !isNodeRunning) return;
  try {
    stopNodeBtn.disabled = true;
    appendLog("[SYSTEM] Shutting down LDK Node...", "system");
    await wallet.stop();
    isNodeRunning = false;
    wallet = null;

    appendLog("[SYSTEM] LDK Node stopped.", "system");

    // Reset UI
    walletStatusBadge.innerText = "Stopped";
    walletStatusBadge.className = "badge badge-status stopped";
    startNodeBtn.disabled = false;
    stopNodeBtn.disabled = true;
    connectLspBtn.disabled = true;
    requestJitBtn.disabled = true;
    purchaseLsps1Btn.disabled = true;
    setV4VEnabled(false);
    setNwcEnabled(false);
    exportStateBtn.disabled = true;
    newWalletBtn.disabled = false;
    nodeIdVal.innerText = "-";
    peersCountVal.innerText = "0";
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
    localStorage.setItem("libre_last_backup_version", String(wallet.getStateVersion()));
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
  if (seed.length !== 64) {
    appendLog("[ERROR] Enter your 64-char hex seed above to decrypt the backup.", "error");
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

// Generate a fresh random LDK seed and clear local state to start a brand-new wallet.
newWalletBtn.addEventListener("click", async () => {
  if (isNodeRunning) {
    appendLog("[ERROR] Stop the node before creating a new wallet.", "error");
    return;
  }
  try {
    const existing = await storage.getItem("ldk_seed");
    if (existing) {
      const confirmed = window.confirm(
        "Create a new wallet? This erases the current wallet's state from this browser. Make sure you've downloaded an encrypted backup first."
      );
      if (!confirmed) {
        appendLog("[SYSTEM] New wallet cancelled.", "system");
        return;
      }
    }
    // Wipe existing wallet state so the new seed boots a clean node.
    await storage.clear();
    // Generate a fresh 32-byte LDK seed.
    const seedBytes = new Uint8Array(32);
    crypto.getRandomValues(seedBytes);
    const seedHex = Array.from(seedBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    seedInput.value = seedHex;
    await storage.setItem("ldk_seed", seedHex);
    nodeIdVal.innerText = "-";
    appendLog(
      "[SYSTEM] New wallet seed generated and local state cleared. Back up your seed, then Start Node.",
      "system"
    );
  } catch (e) {
    appendLog(`[ERROR] New wallet failed: ${e instanceof Error ? e.message : e}`, "error");
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
  const lastStr = localStorage.getItem("libre_last_backup_version");
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
  if (!wallet || !isNodeRunning || !drive.isConnected() || driveSyncing) return;
  if (wallet.getStateVersion() > loadDriveSyncedVersion()) {
    if (driveSyncTimer) clearTimeout(driveSyncTimer);
    driveSyncTimer = setTimeout(() => {
      driveSyncTimer = null;
      void uploadBackupToDrive();
    }, 5000);
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
    await drive.connect(clientId);
    updateDriveStatus();
    appendLog("[SYSTEM] Connected to Google Drive.", "system");
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
    await drive.connect(clientId, { silent: true });
    updateDriveStatus();
    appendLog("[SYSTEM] Auto-connected to Google Drive.", "system");
  } catch {
    updateDriveStatus("not connected");
    appendLog("[SYSTEM] Google Drive: silent reconnect unavailable — click Connect Drive.", "system");
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
    await drive.uploadBackup(await wallet.exportState());
    localStorage.setItem("libre_drive_synced_version", String(version));
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
  if (seed.length !== 64) {
    appendLog("[ERROR] Enter your 64-char hex seed above to decrypt the Drive backup.", "error");
    return;
  }
  try {
    if (!drive.isConnected()) {
      const clientId = resolveClientId();
      if (!clientId) {
        appendLog("[ERROR] No Google OAuth Client ID configured — set VITE_GOOGLE_CLIENT_ID in .env.local.", "error");
        return;
      }
      await drive.connect(clientId);
      updateDriveStatus();
    }
    const blob = await drive.downloadBackup();
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

