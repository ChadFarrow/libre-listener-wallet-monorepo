import { command } from "../ui/rpc";
import { confirmModal } from "../ui/confirm-modal";
import { defaultBridgeUrl, defaultRapidGossipSyncUrl, defaultPeer, parsePeerString } from "../core/wallet-config";
import { downloadBackupName } from "../core/backup-name";

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
    parts = parsePeerString(peer);
  } catch {
    return; // a corrupt saved peer just means no pre-fill
  }
  const pk = $<HTMLInputElement>("peer-pubkey");
  const host = $<HTMLInputElement>("peer-host");
  const port = $<HTMLInputElement>("peer-port");
  if (!pk.value.trim()) pk.value = parts.pubkey;
  if (!host.value.trim()) host.value = parts.host;
  if (!port.value.trim() || port.value === "9735") port.value = String(parts.port);
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

$("connect-peer").addEventListener("click", async () => {
  try {
    await command("connectPeer", {
      pubkey: val("peer-pubkey"),
      host: val("peer-host"),
      port: Number(val("peer-port")) || 9735,
    });
    setMsg("peer-msg", "Peer connected", "ok");
  } catch (e: any) {
    setMsg("peer-msg", e.message, "err");
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

void loadConfig();
void loadGrants();
void loadSweep();
void refreshBackupState();
void refreshAutoDownload();
void refreshDriveStatus();
