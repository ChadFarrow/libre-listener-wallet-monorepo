import { command } from "../ui/rpc";

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
    $<HTMLSelectElement>("network").value = c.network || "mainnet";
    $<HTMLInputElement>("esplora").value = c.esploraUrl || "";
    $<HTMLInputElement>("bridge").value = c.bridgeUrl || "";
    $<HTMLInputElement>("rgs").value = c.rapidGossipSyncUrl || "";
  } catch (e: any) {
    setMsg("config-msg", e.message, "err");
  }
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
  const grants = await command<any[]>("listGrants").catch(() => []);
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
      await command("revokeGrant", { origin: g.origin });
      loadGrants();
    });
    td.appendChild(btn);
    tr.appendChild(td);
    body.appendChild(tr);
  }
}

loadConfig();
loadGrants();
