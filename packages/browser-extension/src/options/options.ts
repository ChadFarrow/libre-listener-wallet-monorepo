import { command } from "../ui/rpc";
import { confirmModal } from "../ui/confirm-modal";
import { defaultBridgeUrl, defaultRapidGossipSyncUrl, defaultPeer } from "../core/wallet-config";

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
    prefillPeer(network);
  } catch (e: any) {
    setMsg("config-msg", e.message, "err");
  }
  // Drive settings are global (not per-network wallet config).
  $<HTMLInputElement>("google-client-id").value = (await command<string>("getGoogleClientId").catch(() => "")) || "";
  // Show the redirect URI the user must register on their OAuth client.
  $<HTMLInputElement>("redirect-uri").value = await command<string>("driveRedirectUri").catch(() => "");
}

// Pre-fill the connect-peer fields with the network's default channel peer (only when blank, so it
// never clobbers what the user typed). Nothing auto-connects — they still click Connect peer.
function prefillPeer(network: string) {
  const peer = defaultPeer(network);
  if (!peer) return;
  const at = peer.lastIndexOf("@");
  const colon = peer.lastIndexOf(":");
  if (at < 0 || colon < at) return;
  const pk = $<HTMLInputElement>("peer-pubkey");
  const host = $<HTMLInputElement>("peer-host");
  const port = $<HTMLInputElement>("peer-port");
  if (!pk.value.trim()) pk.value = peer.slice(0, at);
  if (!host.value.trim()) host.value = peer.slice(at + 1, colon);
  if (!port.value.trim() || port.value === "9735") port.value = peer.slice(colon + 1);
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
    setMsg("drive-msg", "Saved. Open the popup → Backup → Connect Drive.", "ok");
  } catch (e: any) {
    setMsg("drive-msg", e.message, "err");
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
      loadGrants();
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

loadConfig();
loadGrants();
