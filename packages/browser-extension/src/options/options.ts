import QRCode from "qrcode";
import { command, onWalletEvent } from "../ui/rpc";
import { confirmModal } from "../ui/confirm-modal";
import { defaultBridgeUrl, defaultRapidGossipSyncUrl, defaultPeer, parsePeerString, formatPeerString } from "../core/wallet-config";
import { downloadBackupName } from "../core/backup-name";
import {
  LSPS1_REST_PROVIDERS,
  mempoolTxUrl,
  channelConfLabel,
  lsps1OrderStatus,
  type Lsps1RestOrderResponse,
} from "@libre/shared";
import type { ChannelInfo } from "@libre/listener-wallet";
import {
  formatOpeningFee,
  validateAmountForProvider,
  suggestProviderForAmount,
  providerSummary,
  isLeaseOptionAvailable,
  clampLeaseSelectionValue,
} from "../core/lsps1-provider-ui";

let currentNetwork = "mainnet";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => $<HTMLInputElement>(id).value.trim();
const setMsg = (id: string, text: string, kind: "" | "ok" | "err" = "") => {
  const m = $(id);
  m.textContent = text;
  m.className = `msg ${kind}`;
};

async function loadConfig() {
  try {
    const c = await command<any>("getConfig");
    const network = c.network || "mainnet";
    currentNetwork = network;
    $<HTMLSelectElement>("network").value = network;
    $("reset-network").textContent = network;
    // Fall back to the network's public defaults so the fields arrive pre-filled (mainnet ships the
    // same bridge/RGS/peer as the PWA); a saved value always wins.
    $<HTMLInputElement>("esplora").value = c.esploraUrl || "";
    $<HTMLInputElement>("bridge").value = c.bridgeUrl || defaultBridgeUrl(network) || "";
    $<HTMLInputElement>("rgs").value = c.rapidGossipSyncUrl || defaultRapidGossipSyncUrl(network) || "";
    prefillPeer(network, c.peer);
  } catch (e: any) {
    setMsg("config-msg", e.message, "err");
  }
  // Drive settings are global (not per-network wallet config).
  $<HTMLInputElement>("google-client-id").value = (await command<string>("getGoogleClientId").catch(() => "")) || "";
  // Show the redirect URI the user must register on their OAuth client.
  $<HTMLInputElement>("redirect-uri").value = await command<string>("driveRedirectUri").catch(() => "");
}

// Pre-fill the connect-peer fields with the saved (last-connected) peer, falling back to the
// network's default. Only fills blanks, so it never clobbers what the user typed. Nothing
// auto-connects from here — they still click Connect peer.
function prefillPeer(network: string, savedPeer?: string) {
  const peer = savedPeer || defaultPeer(network);
  if (!peer) return;
  let parts;
  try {
    parts = parsePeerString(peer); // validate before pre-filling; a corrupt saved peer = no pre-fill
  } catch {
    return;
  }
  const conn = $<HTMLInputElement>("peer-conn");
  if (!conn.value.trim()) conn.value = formatPeerString(parts.pubkey, parts.host, parts.port);
}

$("save-config").addEventListener("click", async () => {
  try {
    await command("setConfig", {
      network: $<HTMLSelectElement>("network").value,
      esploraUrl: val("esplora"),
      bridgeUrl: val("bridge"),
      rapidGossipSyncUrl: val("rgs"),
    });
    setMsg("config-msg", "Saved", "ok");
  } catch (e: any) {
    setMsg("config-msg", e.message, "err");
  }
});

$("save-drive").addEventListener("click", async () => {
  try {
    await command("setGoogleClientId", { clientId: val("google-client-id") });
    setMsg("drive-msg", "Saved. Now click Connect Drive below.", "ok");
  } catch (e: any) {
    setMsg("drive-msg", e.message, "err");
  }
});

async function loadSweep() {
  const r = await command<{ address: string }>("getSweepAddress").catch((e) => {
    console.warn("[Options] getSweepAddress failed:", e?.message || e);
    return { address: "" };
  });
  $<HTMLInputElement>("sweep-address").value = r.address || "";
}

$("save-sweep").addEventListener("click", async () => {
  try {
    const r = await command<{ address: string }>("setSweepAddress", { address: val("sweep-address") });
    setMsg("sweep-msg", r.address ? "Sweep address saved." : "Sweep address cleared.", "ok");
  } catch (e: any) {
    setMsg("sweep-msg", e.message, "err");
  }
});

// ---- LSPS1: buy inbound capacity from a real mainnet LSP (Megalith / Olympus) ----
// The order button is enabled only when the node is running AND the requested size fits the selected
// provider. lsps1Running is kept live by refreshBackupState (+ wallet events); lsps1Valid by the picker.
let lsps1Running = false;
let lsps1Valid = false;
function updateLsps1OrderBtn() {
  ($("lsps1-order") as HTMLButtonElement).disabled = !(lsps1Running && lsps1Valid);
}

// Reflect the selected provider's cost/lease/bounds, offer only lease durations it grants, and
// validate the amount (Megalith rejects <150k; Olympus serves 100k+).
function refreshLsps1Provider() {
  const providerKey = $<HTMLSelectElement>("lsps1-provider").value;
  const provider = LSPS1_REST_PROVIDERS[providerKey] ?? LSPS1_REST_PROVIDERS.megalith;
  $("lsps1-provider-summary").textContent = providerSummary(provider);

  const amountEl = $<HTMLInputElement>("lsps1-amount");
  amountEl.min = String(provider.minChannelSat);
  amountEl.max = String(provider.maxChannelSat);

  const leaseEl = $<HTMLSelectElement>("lsps1-lease");
  for (const opt of Array.from(leaseEl.options)) {
    if (opt.value === "") {
      opt.textContent = `Longest available (~${provider.leaseMonthsApprox} months, recommended)`;
      continue;
    }
    opt.disabled = !isLeaseOptionAvailable(parseInt(opt.value, 10) || 0, provider.maxLeaseBlocks);
  }
  leaseEl.value = clampLeaseSelectionValue(leaseEl.value, provider.maxLeaseBlocks);

  const amountSats = parseInt(amountEl.value, 10);
  const check = validateAmountForProvider(amountSats, provider);
  const msgEl = $("lsps1-amount-msg");
  if (check.ok) {
    msgEl.textContent = "";
    msgEl.style.color = "";
  } else {
    const alt = suggestProviderForAmount(amountSats, providerKey);
    msgEl.textContent = `${check.message ?? "Invalid amount."}${alt ? ` Try ${alt.provider.name}, which serves this size.` : ""}`;
    msgEl.style.color = "#c0392b";
  }
  lsps1Valid = check.ok;
  updateLsps1OrderBtn();
}
$("lsps1-provider").addEventListener("change", refreshLsps1Provider);
$("lsps1-amount").addEventListener("input", refreshLsps1Provider);

// Polls get_order after the invoice is shown so the user gets live feedback: payment detected →
// hide the invoice + "opening your channel", COMPLETED → "channel open", FAILED → error. A monotonic
// token cancels a stale poll when a new order is placed. Best-effort: transient poll errors are ignored.
let lsps1PollToken = 0;
function hideLsps1Invoice() {
  $("lsps1-invoice").style.display = "none";
  $("lsps1-invoice-label").style.display = "none";
  $("lsps1-invoice-qr").style.display = "none";
}
function startLsps1OrderPoll(apiUrl: string, orderId: string) {
  const token = ++lsps1PollToken;
  const deadline = Date.now() + 15 * 60 * 1000; // stop polling after 15 min
  const tick = async () => {
    if (token !== lsps1PollToken) return; // superseded by a newer order
    try {
      const order = await command<Lsps1RestOrderResponse>("getLSPS1Order", { apiUrl, orderId });
      if (token !== lsps1PollToken) return;
      const status = lsps1OrderStatus(order);
      if (status === "completed") {
        hideLsps1Invoice();
        setMsg("lsps1-msg", "🎉 Channel open! It should appear under Your channels.", "ok");
        void loadChannels();
        return;
      }
      if (status === "failed") {
        setMsg("lsps1-msg", "Order failed — the LSP could not open the channel. No sats were kept.", "err");
        return;
      }
      if (status === "paid") {
        hideLsps1Invoice();
        setMsg("lsps1-msg", "✓ Payment received — opening your channel… (this can take a few confirmations)", "ok");
        void loadChannels();
      }
    } catch {
      /* transient (offline / LSP hiccup) — keep polling */
    }
    if (token === lsps1PollToken && Date.now() < deadline) setTimeout(() => void tick(), 4000);
  };
  setTimeout(() => void tick(), 4000);
}

$("lsps1-order").addEventListener("click", async () => {
  const providerKey = $<HTMLSelectElement>("lsps1-provider").value;
  const provider = LSPS1_REST_PROVIDERS[providerKey] ?? LSPS1_REST_PROVIDERS.megalith;
  const amountSats = parseInt(val("lsps1-amount"), 10);

  const check = validateAmountForProvider(amountSats, provider);
  if (!check.ok) {
    const alt = suggestProviderForAmount(amountSats, providerKey);
    setMsg("lsps1-msg", `${check.message}${alt ? ` Try ${alt.provider.name}.` : ""}`, "err");
    return;
  }

  const leaseRaw = $<HTMLSelectElement>("lsps1-lease").value.trim();
  const channelExpiryBlocks = leaseRaw ? parseInt(leaseRaw, 10) : undefined;

  const btn = $<HTMLButtonElement>("lsps1-order");
  btn.disabled = true;
  $("lsps1-fee-readout").style.display = "none";
  $("lsps1-invoice").style.display = "none";
  $("lsps1-invoice-label").style.display = "none";
  $("lsps1-invoice-qr").style.display = "none";
  setMsg("lsps1-msg", `Getting quote from ${provider.name}…`);

  try {
    const order = await command<{ orderId: string; invoice: string; feeTotalSat?: string }>("purchaseLSPS1Capacity", {
      amountSats,
      apiUrl: provider.restBaseUrl,
      providerName: provider.name,
      ...(channelExpiryBlocks != null ? { channelExpiryBlocks } : {}),
    });
    const feeText = formatOpeningFee(order.feeTotalSat, amountSats);
    const fee = $("lsps1-fee-readout");
    fee.textContent = `${provider.name} opening fee: ${feeText} — pay only if you want this channel.`;
    fee.style.display = "block";
    const inv = $<HTMLTextAreaElement>("lsps1-invoice");
    inv.value = order.invoice;
    inv.style.display = "block";
    $("lsps1-invoice-label").style.display = "block";
    // Render the QR on-device (bundled qrcode) — never via a QR image service. Best-effort: the
    // textarea is the fallback if rendering fails.
    try {
      const qr = $<HTMLImageElement>("lsps1-invoice-qr");
      qr.src = await QRCode.toDataURL(order.invoice, { width: 220, margin: 1 });
      qr.style.display = "block";
    } catch (qrErr: any) {
      console.warn("[LSPS1] could not render invoice QR:", qrErr?.message || qrErr);
    }
    setMsg("lsps1-msg", `Order ${order.orderId} placed. Pay the invoice below to open the channel.`, "ok");
    startLsps1OrderPoll(provider.restBaseUrl, order.orderId);
  } catch (e: any) {
    setMsg("lsps1-msg", e.message, "err");
  } finally {
    btn.disabled = false;
    updateLsps1OrderBtn(); // re-apply the running/valid gate
  }
});

$("connect-peer").addEventListener("click", async () => {
  let peer;
  try {
    peer = parsePeerString(val("peer-conn")); // validates pubkey/host/port shape
  } catch (e: any) {
    setMsg("peer-msg", e.message, "err");
    return;
  }
  try {
    await command("connectPeer", { pubkey: peer.pubkey, host: peer.host, port: peer.port });
    setMsg("peer-msg", "Peer connected", "ok");
  } catch (e: any) {
    setMsg("peer-msg", e.message, "err");
  }
});

$("copy-peer").addEventListener("click", async () => {
  let conn;
  try {
    const p = parsePeerString(val("peer-conn")); // normalize (lowercase pubkey, trimmed) before copying
    conn = formatPeerString(p.pubkey, p.host, p.port);
  } catch {
    setMsg("peer-msg", "Enter a full pubkey@host:port first.", "err");
    return;
  }
  try {
    await navigator.clipboard.writeText(conn);
    setMsg("peer-msg", `Copied ${conn}`, "ok");
  } catch {
    setMsg("peer-msg", `Copy failed — connection string: ${conn}`, "err");
  }
});

// ---- backup: manual export + auto-download + Google Drive ----

// Export/back-up-now need the wallet host running (exportBackup calls requireRunning). Disable them
// when the node is stopped so a click can't fail with a confusing error; the popup starts the node.
async function refreshBackupState() {
  const running = await command<{ running: boolean }>("getState")
    .then((s) => !!s.running)
    .catch(() => false);
  ($("export") as HTMLButtonElement).disabled = !running;
  ($("drive-backup-now") as HTMLButtonElement).disabled = !running;
  if (!running) setMsg("backup-msg", "Start the node in the popup to export or sync a backup.");
  lsps1Running = running;
  updateLsps1OrderBtn();
}

$("export").addEventListener("click", async () => {
  setMsg("backup-msg", "Preparing backup…");
  try {
    const env = await command<string>("exportBackup");
    const state = await command<{ network: string }>("getState").catch(() => ({ network: "mainnet" }));
    const name = downloadBackupName(state.network || "mainnet", env, new Date());
    // Download the (large) encrypted envelope as a file — no giant clipboard/textarea.
    const url = URL.createObjectURL(new Blob([env], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setMsg("backup-msg", `Downloaded ${name}. Store it safely.`, "ok");
  } catch (e: any) {
    setMsg("backup-msg", e.message, "err");
  }
});

// Auto-download toggle: persisted in the background (chrome.storage.local).
async function refreshAutoDownload() {
  const on = await command<boolean>("getAutoDownload").catch(() => false);
  ($("auto-download") as HTMLInputElement).checked = !!on;
}
$("auto-download").addEventListener("change", async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  await command("setAutoDownload", { enabled }).catch((err) => setMsg("backup-msg", err.message, "err"));
  setMsg(
    "backup-msg",
    enabled ? "Auto-backup on. A dated file saves to Downloads when your wallet changes." : "Auto-backup off.",
    "ok"
  );
});

async function refreshDriveStatus() {
  const s = await command<{ connected: boolean; email: string | null }>("driveStatus").catch((e) => {
    console.warn("[Options] driveStatus failed:", e?.message || e);
    return null;
  });
  if (!s) return;
  $("drive-status").textContent = s.connected
    ? `Google Drive: connected${s.email ? ` (${s.email})` : ""} — auto-syncing`
    : s.email
      ? `Google Drive: reconnect ${s.email}`
      : "Google Drive: not connected";
  ($("drive-connect") as HTMLButtonElement).textContent = s.connected ? "Reconnect" : "Connect Drive";
}

$("drive-connect").addEventListener("click", async () => {
  setMsg("backup-msg", "Opening Google sign-in…");
  try {
    const { email } = await command<{ email: string | null }>("driveConnect");
    setMsg("backup-msg", `Drive connected${email ? ` as ${email}` : ""}`, "ok");
    void refreshDriveStatus();
  } catch (e: any) {
    setMsg("backup-msg", e.message, "err");
  }
});

$("drive-backup-now").addEventListener("click", async () => {
  setMsg("backup-msg", "Backing up to Drive…");
  try {
    const { network } = await command<{ network: string }>("driveBackupNow");
    setMsg("backup-msg", `Backed up (${network}) to Google Drive`, "ok");
  } catch (e: any) {
    setMsg("backup-msg", e.message, "err");
  }
});

async function loadGrants() {
  const grants = await command<any[]>("listGrants").catch((e) => {
    console.warn("[Options] listGrants failed:", e?.message || e);
    return [];
  });
  const body = $("grants").querySelector("tbody")!;
  body.innerHTML = "";
  if (!grants.length) {
    body.innerHTML = `<tr><td colspan="3" class="hint">No sites approved yet.</td></tr>`;
    return;
  }
  for (const g of grants) {
    const tr = document.createElement("tr");
    const cap = g.spendingLimitSats > 0 ? `${g.spentTodaySats}/${g.spendingLimitSats} sat` : "unlimited";
    tr.innerHTML = `<td>${g.origin}</td><td>${cap}</td>`;
    const td = document.createElement("td");
    const btn = document.createElement("button");
    btn.textContent = "Revoke";
    btn.className = "ghost";
    btn.style.margin = "0";
    btn.addEventListener("click", async () => {
      const ok = await confirmModal({
        title: "Revoke access?",
        body: `Remove WebLN access for ${g.origin}? It will have to ask for approval again next time.`,
        confirmLabel: "Revoke",
        danger: true,
      });
      if (!ok) return;
      await command("revokeGrant", { origin: g.origin });
      void loadGrants();
    });
    td.appendChild(btn);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

$("reset-wallet").addEventListener("click", async () => {
  const network = $("reset-network").textContent || "this network";
  const ok = await confirmModal({
    title: `Delete the ${network} wallet?`,
    body:
      `This permanently erases the seed, channel state, and monitors for the ${network} wallet from ` +
      `this browser. Any funds in a live channel will be lost unless you have a backup. This cannot be undone.`,
    confirmLabel: "Delete wallet",
    danger: true,
  });
  if (!ok) return;
  const btn = $<HTMLButtonElement>("reset-wallet");
  btn.disabled = true;
  setMsg("reset-msg", "Deleting…");
  try {
    const r = await command<{ network: string }>("resetWallet");
    setMsg("reset-msg", `Wallet on ${r.network} deleted. Open the popup to create or restore a wallet.`, "ok");
  } catch (e: any) {
    setMsg("reset-msg", e.message, "err");
  } finally {
    btn.disabled = false;
  }
});

// Render the channels this wallet holds, with a funding-tx block-explorer link per channel.
async function loadChannels() {
  const el = $("channels-list");
  const running = await command<{ running: boolean }>("getState")
    .then((s) => !!s.running)
    .catch(() => false);
  if (!running) {
    el.textContent = "Start the node in the popup to see your channels.";
    return;
  }
  const chans = await command<ChannelInfo[]>("getChannels").catch((e) => {
    console.warn("[Options] getChannels failed:", e?.message || e);
    return [] as ChannelInfo[];
  });
  if (!chans.length) {
    el.textContent = "No channels yet.";
    return;
  }
  el.innerHTML = chans
    .map((c) => {
      const conf = channelConfLabel(c.confirmations, c.confirmationsRequired, c.isChannelReady);
      const state = c.isUsable
        ? "active"
        : c.isChannelReady
          ? "ready (peer offline)"
          : `pending${conf ? ` · ${conf}` : ""}`;
      const color = c.isUsable ? "#22c45e" : c.isChannelReady ? "#e0a800" : "#888";
      const txUrl = c.fundingTxid ? mempoolTxUrl(c.fundingTxid, currentNetwork) : null;
      const txLink = txUrl ? ` · <a href="${txUrl}" target="_blank" rel="noopener">funding tx ↗</a>` : "";
      return (
        `<div style="padding:8px 0;border-bottom:1px solid #8883">` +
        `<div style="word-break:break-all"><b>${c.channelId}</b> <span style="color:${color}">● ${state}</span></div>` +
        `<div class="hint">capacity ${c.capacitySat.toLocaleString()} sat · send ${c.outboundSendableSat.toLocaleString()} / recv ${c.inboundSat.toLocaleString()}${txLink}</div>` +
        `<div class="hint" style="word-break:break-all">peer ${c.counterpartyNodeId}</div>` +
        `</div>`
      );
    })
    .join("");
}

// loadChannels reads currentNetwork (for the explorer link), which loadConfig sets — chain them.
// Recovery phrase: show the seed as its 24-word BIP39 phrase, blurred until Unhide (anti
// shoulder-surf). Reads the stored seed via the offscreen host — works node running or not.
async function loadPhrase() {
  const box = $<HTMLTextAreaElement>("phrase-words");
  try {
    const { mnemonic } = await command<{ mnemonic: string }>("getRecoveryPhrase");
    box.value = mnemonic;
  } catch (e: any) {
    box.value = ""; // no wallet on this network yet, or read failed
    setMsg("phrase-msg", e?.message || "No recovery phrase yet — create or restore a wallet first.");
  }
}
$("toggle-phrase-blur").addEventListener("click", () => {
  const blurred = $<HTMLTextAreaElement>("phrase-words").classList.toggle("phrase-blur");
  $("toggle-phrase-blur").textContent = blurred ? "Unhide" : "Hide";
  if (!blurred) setMsg("phrase-msg", "Write these 24 words down in order and keep them offline.", "ok");
});
$("copy-phrase").addEventListener("click", async () => {
  const words = $<HTMLTextAreaElement>("phrase-words").value.trim();
  if (!words) {
    setMsg("phrase-msg", "No recovery phrase to copy.", "err");
    return;
  }
  try {
    await navigator.clipboard.writeText(words);
    setMsg("phrase-msg", "Recovery phrase copied to clipboard.", "ok");
  } catch {
    setMsg("phrase-msg", "Copy failed.", "err");
  }
});

void loadConfig().then(() => void loadChannels());
void loadGrants();
void loadSweep();
void loadPhrase();
void refreshBackupState();
void refreshAutoDownload();
void refreshDriveStatus();
refreshLsps1Provider();

// Keep node-running-gated controls live if the node is started/stopped from the popup while this
// page is open (backup buttons + the LSPS1 order button + the channels list).
onWalletEvent((event) => {
  if (event === "state-changed" || event === "status") {
    void refreshBackupState();
    void loadChannels();
    void loadPhrase();
  }
});
