import {
  LibreListenerWallet,
  SecureStorageProvider,
  WebSocketStreamProvider,
  WebSocketConnection,
} from "@libre/listener-wallet";
import { calculateSplits } from "@libre/shared";

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
const storage = new IndexedDBStorageProvider();

// 3. Logger helper to update UI terminal console
const terminalContent = document.getElementById("terminal-content") as HTMLDivElement;
const logFilter = document.getElementById("log-filter") as HTMLSelectElement;

function appendLog(msg: string, type: "info" | "warn" | "error" | "system" | "ldk-info" | "ldk-debug" | "ldk-trace") {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.innerText = msg;
  terminalContent.appendChild(line);
  
  // Keep scrolling to the bottom
  terminalContent.parentElement!.scrollTop = terminalContent.parentElement!.scrollHeight;

  // Filter visibility based on current selection
  applyLogFilter();
}

function applyLogFilter() {
  const filter = logFilter.value;
  const lines = terminalContent.querySelectorAll(".log-line");
  lines.forEach((lineNode) => {
    const el = lineNode as HTMLDivElement;
    if (filter === "all") {
      el.style.display = "block";
    } else if (filter === "error" && el.classList.contains("error")) {
      el.style.display = "block";
    } else if (filter === "warn" && el.classList.contains("warn")) {
      el.style.display = "block";
    } else if (filter === "info" && (el.classList.contains("info") || el.classList.contains("system") || el.classList.contains("ldk-info"))) {
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  });
}

// 4. Wallet Lifecycle State
let wallet: LibreListenerWallet | null = null;
let isNodeRunning = false;
// Set when the wallet is auto-started on page load, so the start handler knows to
// also auto-connect the peer once the node is running.
let autoConnectMode = false;

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

  // Auto-connect on page load: start the node (which then auto-connects the peer),
  // and silently re-authorize Google Drive. No-op if there's no saved seed.
  if (seedInput.value && /^[0-9a-fA-F]{64}$/.test(seedInput.value)) {
    autoConnectMode = true;
    appendLog("[SYSTEM] Auto-starting wallet…", "system");
    startNodeBtn.click();
  }
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

const clearLogsBtn = document.getElementById("clear-logs-btn") as HTMLButtonElement;
const copyLogsBtn = document.getElementById("copy-logs-btn") as HTMLButtonElement;

// V4V Elements
const audioPlayer = document.getElementById("audio-player") as HTMLAudioElement;
const streamRateInput = document.getElementById("stream-rate-input") as HTMLInputElement;
const streamModeStatus = document.getElementById("stream-mode-status") as HTMLSpanElement;
const satsStreamedVal = document.getElementById("sats-streamed-val") as HTMLSpanElement;

const boostAmountInput = document.getElementById("boost-amount") as HTMLInputElement;
const boostMessageInput = document.getElementById("boost-message") as HTMLInputElement;
const boostSenderName = document.getElementById("boost-sender-name") as HTMLInputElement;
const boostDestInput = document.getElementById("boost-dest") as HTMLInputElement;
const sendBoostagramBtn = document.getElementById("send-boostagram-btn") as HTMLButtonElement;

// Receive (create invoice) Elements
const receiveAmountInput = document.getElementById("receive-amount") as HTMLInputElement;
const receiveDescInput = document.getElementById("receive-desc") as HTMLInputElement;
const createInvoiceBtn = document.getElementById("create-invoice-btn") as HTMLButtonElement;
const receiveInvoiceContainer = document.getElementById("receive-invoice-container") as HTMLDivElement;
const receiveInvoiceStr = document.getElementById("receive-invoice-str") as HTMLTextAreaElement;
const copyReceiveInvoiceBtn = document.getElementById("copy-receive-invoice-btn") as HTMLButtonElement;

// NWC Elements
const createNwcBtn = document.getElementById("create-nwc-btn") as HTMLButtonElement;
const nwcConnNameInput = document.getElementById("nwc-conn-name") as HTMLInputElement;
const nwcSpendingLimitInput = document.getElementById("nwc-spending-limit") as HTMLInputElement;
const nwcRelayUrlInput = document.getElementById("nwc-relay-url") as HTMLInputElement;
const nwcUriContainer = document.getElementById("nwc-uri-container") as HTMLDivElement;
const nwcUriStr = document.getElementById("nwc-uri-str") as HTMLTextAreaElement;
const copyNwcUriBtn = document.getElementById("copy-nwc-uri-btn") as HTMLButtonElement;
const nwcQrImg = document.getElementById("nwc-qr-img") as HTMLImageElement;
const nwcConnectionsList = document.getElementById("nwc-connections-list") as HTMLDivElement;

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

let streamIntervalId: any = null;
let totalSatsStreamed = 0;


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

clearLogsBtn.addEventListener("click", () => {
  terminalContent.innerHTML = "";
  appendLog("[SYSTEM] Console cleared.", "system");
});

copyLogsBtn.addEventListener("click", async () => {
  // Copy every log line (regardless of the active filter) as plain text.
  const lines = Array.from(terminalContent.querySelectorAll(".log-line")).map((el) => el.textContent || "");
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    appendLog(`[SYSTEM] Copied ${lines.length} log lines to clipboard.`, "system");
  } catch (e) {
    appendLog(`[ERROR] Failed to copy logs: ${e instanceof Error ? e.message : e}`, "error");
  }
});

logFilter.addEventListener("change", applyLogFilter);

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
        // Rapid Gossip Sync populates the network graph so the router can find
        // multi-hop routes (pay nodes you're not directly channeled to). Only
        // mainnet/testnet have public RGS servers.
        rapidGossipSyncUrl:
          selectedNetwork === "mainnet"
            ? "https://rapidsync.lightningdevkit.org/snapshot"
            : selectedNetwork === "testnet"
            ? "https://rapidsync.lightningdevkit.org/testnet/snapshot"
            : undefined,
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
    appendLog("[SYSTEM] LDK Node running successfully!", "system");

    // Update UI Status
    walletStatusBadge.innerText = "Running";
    walletStatusBadge.className = "badge badge-status running";
    stopNodeBtn.disabled = false;
    connectLspBtn.disabled = false;
    requestJitBtn.disabled = false;
    purchaseLsps1Btn.disabled = false;
    sendBoostagramBtn.disabled = false;
    createInvoiceBtn.disabled = false;
    createNwcBtn.disabled = false;
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
    sendBoostagramBtn.disabled = true;
    createNwcBtn.disabled = true;
    exportStateBtn.disabled = true;
    newWalletBtn.disabled = false;
    nwcUriContainer.classList.add("hidden");
    nwcConnectionsList.innerHTML = '<div class="empty-list-text text-muted" style="font-size: 0.85rem;">No active pairings yet.</div>';
    nodeIdVal.innerText = "-";
    peersCountVal.innerText = "0";
    jitInvoiceContainer.classList.add("hidden");
    lsps1InvoiceContainer.classList.add("hidden");

    // Reset V4V state
    audioPlayer.pause();
    if (streamIntervalId) {
      clearInterval(streamIntervalId);
      streamIntervalId = null;
    }
    streamModeStatus.innerText = "Inactive";
    streamModeStatus.className = "value text-warning";
    totalSatsStreamed = 0;
    satsStreamedVal.innerText = "0";

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

copyJitInvoiceBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(jitInvoiceStr.value);
  appendLog("[SYSTEM] JIT Invoice copied to clipboard.", "system");
});

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

copyReceiveInvoiceBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(receiveInvoiceStr.value);
  appendLog("[SYSTEM] Invoice copied to clipboard.", "system");
});

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

copyLsps1InvoiceBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(lsps1InvoiceStr.value);
  appendLog("[SYSTEM] LSPS1 Invoice copied to clipboard.", "system");
});

// 11. V4V Audio Streaming Event Listeners
audioPlayer.addEventListener("play", () => {
  if (!wallet || !isNodeRunning) {
    appendLog("[SYSTEM] Start the LDK Node before playing to enable V4V streaming.", "warn");
    audioPlayer.pause();
    return;
  }
  
  appendLog("[V4V] Audio playback started. Beginning streaming micropayments...", "system");
  streamModeStatus.innerText = "Active";
  streamModeStatus.className = "value text-success";
  
  if (streamIntervalId) clearInterval(streamIntervalId);
  
  // Send payments every 10 seconds (for testing convenience)
  streamIntervalId = setInterval(async () => {
    if (!wallet || !isNodeRunning) {
      clearInterval(streamIntervalId);
      return;
    }
    
    const rateSatsMin = parseInt(streamRateInput.value, 10);
    const amountSats = Math.max(1, Math.round((rateSatsMin * 10) / 60));
    
    appendLog(`[V4V] Streaming ${amountSats} sats (interval: 10s)...`, "info");
    
    // Creator pubkey and App Dev pubkey
    const creatorPubkey = "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24";
    const appDevPubkey = "035c6ec9ffea21051515efbb72d2fb07dfb51fa16d78772cc1c9b6348981f185ef";
    
    const destinations = [
      { destinationPubkey: creatorPubkey, share: 90 },
      { destinationPubkey: appDevPubkey, share: 10 },
    ];
    
    const splits = calculateSplits({
      destinations,
      amountSats,
      boostRecordTemplate: {
        action: "stream",
        app_name: "v4vmusic-player",
        ts: Math.floor(audioPlayer.currentTime),
      },
    });
    
    const res = await wallet.sendSplitPayments(splits);
    if (res.ok) {
      totalSatsStreamed += amountSats;
      satsStreamedVal.innerText = totalSatsStreamed.toString();
      appendLog(`[V4V] Successfully streamed ${amountSats} sats split!`, "info");
    } else {
      appendLog(`[V4V] Failed streaming split payment: some recipients failed. Check LDK logs.`, "error");
    }
  }, 10000);
});

const stopStreaming = () => {
  if (streamIntervalId) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
  streamModeStatus.innerText = "Inactive";
  streamModeStatus.className = "value text-warning";
  appendLog("[V4V] Audio playback paused/stopped. Stopped streaming micropayments.", "system");
};

audioPlayer.addEventListener("pause", stopStreaming);
audioPlayer.addEventListener("ended", stopStreaming);
audioPlayer.addEventListener("error", stopStreaming);

// 12. Send Boostagram Splits
sendBoostagramBtn.addEventListener("click", async () => {
  if (!wallet || !isNodeRunning) return;
  try {
    sendBoostagramBtn.disabled = true;
    const amountSats = parseInt(boostAmountInput.value, 10);
    const message = boostMessageInput.value.trim();
    const senderName = boostSenderName.value.trim();
    
    appendLog(`[V4V] Preparing Boostagram of ${amountSats} sats with message: "${message}"...`, "system");

    const creatorPubkey = "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24";
    const appDevPubkey = "035c6ec9ffea21051515efbb72d2fb07dfb51fa16d78772cc1c9b6348981f185ef";

    // If a destination override pubkey is provided, route 100% there (e.g. your
    // channel peer, the only node you have a route to). Otherwise the demo 90/10 split.
    const destOverride = boostDestInput.value.trim();
    const destinations = /^0[0-9a-fA-F]{65}$/.test(destOverride)
      ? [{ destinationPubkey: destOverride, share: 100 }]
      : [
          { destinationPubkey: creatorPubkey, share: 90 },
          { destinationPubkey: appDevPubkey, share: 10 },
        ];
    if (destinations.length === 1) {
      appendLog(`[V4V] Routing 100% to override destination ${destOverride.substring(0, 12)}...`, "system");
    }
    
    const splits = calculateSplits({
      destinations,
      amountSats,
      boostRecordTemplate: {
        action: "boost",
        app_name: "v4vmusic-player",
        message,
        sender_name: senderName,
        ts: Math.floor(audioPlayer.currentTime),
      },
    });
    
    const res = await wallet.sendSplitPayments(splits);
    if (res.ok) {
      appendLog(`[V4V] Boostagram sent successfully! Total ${amountSats} sats split:`, "info");
      for (const r of res.results) {
        const hash = r.result.ok ? r.result.paymentHash : "N/A";
        appendLog(` -> ${r.destinationPubkey.substring(0, 8)}... gets ${r.amountSats} sats, status: OK, paymentHash: ${hash}`, "info");
      }
    } else {
      appendLog(`[V4V] Failed to send Boostagram: one or more payments failed.`, "error");
      for (const r of res.results) {
        const status = r.result.ok ? "OK" : `Error: ${r.result.error}`;
        appendLog(` -> ${r.destinationPubkey.substring(0, 8)}... gets ${r.amountSats} sats, status: ${status}`, "error");
      }
    }
  } catch (err: any) {
    appendLog(`[ERROR] Boostagram sending failed: ${err.message}`, "error");
  } finally {
    sendBoostagramBtn.disabled = false;
    createInvoiceBtn.disabled = false;
  }
});

// 13. Nostr Wallet Connect (NWC) Event Listeners & Helpers
createNwcBtn.addEventListener("click", async () => {
  if (!wallet || !isNodeRunning) return;
  try {
    createNwcBtn.disabled = true;
    nwcUriContainer.classList.add("hidden");
    nwcQrImg.classList.add("hidden");

    const name = nwcConnNameInput.value.trim() || "Nostr Client App";
    const limit = parseInt(nwcSpendingLimitInput.value, 10) || 0;
    const relayUrl = nwcRelayUrlInput.value.trim() || "wss://relay.getalby.com/v1";

    appendLog(`[NWC] Creating connection pairing: "${name}" with limit: ${limit} sats on relay ${relayUrl}...`, "system");
    const uri = await wallet.nwc.createConnection(name, {
      spendingLimitSats: limit,
      relayUrl,
    });

    appendLog(`[NWC] Connection created successfully!`, "system");
    nwcUriStr.value = uri;
    nwcQrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(uri)}`;
    nwcQrImg.classList.remove("hidden");
    nwcUriContainer.classList.remove("hidden");

    await updateNwcConnectionsList();
  } catch (err: any) {
    appendLog(`[ERROR] NWC connection creation failed: ${err.message}`, "error");
  } finally {
    createNwcBtn.disabled = false;
  }
});

copyNwcUriBtn.addEventListener("click", () => {
  if (!nwcUriStr.value) return;
  navigator.clipboard.writeText(nwcUriStr.value);
  appendLog("[SYSTEM] NWC Connection URI copied to clipboard.", "system");
});

async function updateNwcConnectionsList() {
  if (!wallet) return;
  try {
    const list = await wallet.nwc.listConnections();
    nwcConnectionsList.innerHTML = "";

    if (list.length === 0) {
      nwcConnectionsList.innerHTML = '<div class="empty-list-text text-muted" style="font-size: 0.85rem;">No active pairings yet.</div>';
      return;
    }

    for (const conn of list) {
      const item = document.createElement("div");
      item.className = "connection-item";

      const details = document.createElement("div");
      details.className = "connection-details";

      const nameEl = document.createElement("div");
      nameEl.className = "connection-name";
      nameEl.innerText = conn.name;

      const metaEl = document.createElement("div");
      metaEl.className = "connection-meta";

      const pubkeyEl = document.createElement("span");
      pubkeyEl.className = "connection-pubkey";
      pubkeyEl.innerText = `${conn.clientPubkey.substring(0, 8)}...`;
      pubkeyEl.title = conn.clientPubkey;

      const limitEl = document.createElement("span");
      limitEl.className = "connection-limit";
      const limitStr = conn.spendingLimitSats > 0 
        ? `Limit: ${conn.spentTodaySats}/${conn.spendingLimitSats} sats`
        : "Limit: Unlimited";
      limitEl.innerText = limitStr;

      const relayEl = document.createElement("span");
      relayEl.className = "connection-relay";
      relayEl.innerText = `Relay: ${conn.relayUrl}`;

      metaEl.appendChild(pubkeyEl);
      metaEl.appendChild(limitEl);
      metaEl.appendChild(relayEl);

      details.appendChild(nameEl);
      details.appendChild(metaEl);

      const revokeBtn = document.createElement("button");
      revokeBtn.className = "btn-revoke";
      revokeBtn.innerText = "Revoke";
      revokeBtn.addEventListener("click", async () => {
        try {
          revokeBtn.disabled = true;
          appendLog(`[NWC] Revoking connection for ${conn.name}...`, "system");
          await wallet!.nwc.deleteConnection(conn.clientPubkey);
          appendLog(`[NWC] Connection revoked.`, "system");
          await updateNwcConnectionsList();
        } catch (e: any) {
          appendLog(`[ERROR] Failed to revoke connection: ${e.message}`, "error");
          revokeBtn.disabled = false;
        }
      });

      item.appendChild(details);
      item.appendChild(revokeBtn);
      nwcConnectionsList.appendChild(item);
    }
  } catch (err: any) {
    console.error("Failed to update connections list", err);
  }
}

// --- Service Worker & Web Push Registration ---
const registerPushBtn = document.getElementById("register-push-btn") as HTMLButtonElement;
const unregisterPushBtn = document.getElementById("unregister-push-btn") as HTMLButtonElement;
const pushStatusVal = document.getElementById("push-status-val") as HTMLSpanElement;
const pushGatewayUrlInput = document.getElementById("push-gateway-url") as HTMLInputElement;
const simulateOfflinePushBtn = document.getElementById("simulate-offline-push-btn") as HTMLButtonElement;

let swRegistration: ServiceWorkerRegistration | null = null;

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function initServiceWorker() {
  if ("serviceWorker" in navigator && "PushManager" in window) {
    try {
      appendLog("[SYSTEM] Registering Service Worker...", "system");
      swRegistration = await navigator.serviceWorker.register("/service-worker.js", { type: "module" });
      appendLog("[SYSTEM] Service Worker registered successfully!", "system");

      const subscription = await swRegistration.pushManager.getSubscription();
      if (subscription) {
        pushStatusVal.innerText = "Registered";
        pushStatusVal.className = "value text-success";
        registerPushBtn.disabled = true;
        unregisterPushBtn.disabled = false;
      }
    } catch (e: any) {
      appendLog(`[ERROR] SW registration failed: ${e.message}`, "error");
    }
  } else {
    appendLog("[WARN] Service Worker or Push Notifications are not supported in this browser.", "warn");
    registerPushBtn.disabled = true;
  }
}

initServiceWorker();

registerPushBtn.addEventListener("click", async () => {
  if (!swRegistration || !wallet) {
    appendLog("[WARN] Start LDK node first to pairing wallet for push registration.", "warn");
    return;
  }

  try {
    registerPushBtn.disabled = true;
    appendLog("[SYSTEM] Requesting notification permission...", "system");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Notification permission denied");
    }

    const gatewayUrl = pushGatewayUrlInput.value.trim().replace(/\/$/, "");

    appendLog(`[Push] Fetching VAPID public key from ${gatewayUrl}...`, "info");
    const vapidRes = await fetch(`${gatewayUrl}/api/vapid-public-key`);
    if (!vapidRes.ok) throw new Error("Failed to fetch VAPID key");
    const { publicKey: vapidPubKey } = await vapidRes.json();

    appendLog("[Push] Subscribing via browser PushManager...", "info");
    const subscription = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPubKey)
    });

    const walletPubkey = wallet.nwc.getWalletPubkey();
    const relayUrl = nwcRelayUrlInput.value.trim();

    appendLog("[Push] Sending subscription details to gateway...", "info");
    const regRes = await fetch(`${gatewayUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletPubkey,
        relayUrl,
        subscription
      })
    });

    if (!regRes.ok) {
      throw new Error("Failed to register subscription with gateway");
    }

    pushStatusVal.innerText = "Registered";
    pushStatusVal.className = "value text-success";
    unregisterPushBtn.disabled = false;
    appendLog("[Push] Web Push Notification wakeup enabled successfully!", "system");

  } catch (err: any) {
    appendLog(`[ERROR] Push registration failed: ${err.message}`, "error");
    registerPushBtn.disabled = false;
  }
});

unregisterPushBtn.addEventListener("click", async () => {
  if (!swRegistration) return;
  try {
    unregisterPushBtn.disabled = true;
    const subscription = await swRegistration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();

      if (wallet) {
        const gatewayUrl = pushGatewayUrlInput.value.trim().replace(/\/$/, "");
        const walletPubkey = wallet.nwc.getWalletPubkey();
        const relayUrl = nwcRelayUrlInput.value.trim();

        await fetch(`${gatewayUrl}/api/unregister`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletPubkey, relayUrl })
        });
      }
    }

    pushStatusVal.innerText = "Not Registered";
    pushStatusVal.className = "value text-warning";
    registerPushBtn.disabled = false;
    appendLog("[Push] Web Push Notification un-registered.", "system");

  } catch (err: any) {
    appendLog(`[ERROR] Push unregistration failed: ${err.message}`, "error");
    unregisterPushBtn.disabled = false;
  }
});

simulateOfflinePushBtn.addEventListener("click", async () => {
  try {
    simulateOfflinePushBtn.disabled = true;

    const storage = new IndexedDBStorageProvider();
    const connJson = await storage.getItem("nwc_connections");
    const connections = connJson ? JSON.parse(connJson) : [];
    if (connections.length === 0) {
      throw new Error("Create an NWC Connection (Section 7) first to retrieve active keys.");
    }

    const conn = connections[connections.length - 1];
    const clientSecretHex = conn.secret;

    const walletPrivKeyHex = await storage.getItem("nwc_wallet_private_key");
    if (!walletPrivKeyHex) {
      throw new Error("Wallet private key not found in storage. Start the node first.");
    }

    const { getPublicKey: derivePubkey, Relay: NostrRelay, finalizeEvent: nostrFinalize, nip04: nostrNip04 } = await import("nostr-tools");

    const hexToBytesHelper = (hex: string) => {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    };

    const targetPubkey = derivePubkey(hexToBytesHelper(walletPrivKeyHex));
    const relayUrl = conn.relayUrl;

    appendLog(`[Simulate] Connecting to Nostr relay: ${relayUrl} to publish NWC request...`, "info");
    const relay = await NostrRelay.connect(relayUrl);

    const requestPayload = {
      jsonrpc: "2.0",
      id: "sim-request-" + Math.floor(Math.random() * 100000),
      method: "get_balance",
      params: {}
    };

    appendLog("[Simulate] Encrypting NWC get_balance request payload...", "info");
    const encryptedContent = await nostrNip04.encrypt(clientSecretHex, targetPubkey, JSON.stringify(requestPayload));

    const event = {
      kind: 23194,
      tags: [["p", targetPubkey]],
      content: encryptedContent,
      created_at: Math.floor(Date.now() / 1000)
    };

    const finalizedEvent = nostrFinalize(event, hexToBytesHelper(clientSecretHex));

    appendLog(`[Simulate] Publishing kind 23194 request to relay. Event ID: ${finalizedEvent.id}`, "info");
    await relay.publish(finalizedEvent);
    appendLog("[Simulate] Event published successfully! Closing Nostr connection.", "system");
    await relay.close();

    appendLog("[SYSTEM] Simulated NWC request event published to relay. Waking up background Service Worker...", "system");

  } catch (err: any) {
    appendLog(`[ERROR] Simulation failed: ${err.message}`, "error");
  } finally {
    simulateOfflinePushBtn.disabled = false;
  }
});

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
setInterval(refreshBackupStatus, 2000);

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

// Auto-upload to Drive (debounced) whenever channel state advances past what's synced.
setInterval(() => {
  if (!wallet || !isNodeRunning || !drive.isConnected() || driveSyncing) return;
  if (wallet.getStateVersion() > loadDriveSyncedVersion()) {
    if (driveSyncTimer) clearTimeout(driveSyncTimer);
    driveSyncTimer = setTimeout(() => {
      driveSyncTimer = null;
      void uploadBackupToDrive();
    }, 5000);
  }
}, 2000);

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

