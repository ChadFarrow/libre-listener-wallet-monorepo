import { command, onWalletEvent } from "../ui/rpc";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (el: HTMLElement, on: boolean) => el.classList.toggle("hidden", !on);

function setMsg(text: string, kind: "" | "ok" | "err" = "") {
  const m = $("msg");
  m.textContent = text;
  m.className = `msg ${kind}`;
}

function randomSeedHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function refresh() {
  try {
    const s = await command<any>("getState");
    $("net").textContent = s.network;
    $("dot").classList.toggle("on", s.running);

    const hasWallet = s.hasSeed || s.createdNew || s.hasChannelState;
    show($("wallet-view"), hasWallet);
    show($("setup-view"), !hasWallet);

    if (hasWallet) {
      $("spendable").textContent = s.balance ? `${s.balance.spendableSat} sat` : "—";
      $("receivable").textContent = s.balance ? `${s.balance.receivableSat} sat` : "—";
      $("channels").textContent = s.channels ?? "—";
      $("peers").textContent = s.peers ?? "—";
      $("nodeid").textContent = s.nodeId || "(start the node to load)";
      show($("start"), !s.running);
      show($("stop"), s.running);
    }
  } catch (e: any) {
    setMsg(e.message, "err");
  }
}

// ---- lifecycle ----
$("start").addEventListener("click", async () => {
  setMsg("Starting node…");
  try {
    await command("startNode");
    setMsg("Node started", "ok");
  } catch (e: any) {
    setMsg(e.message, "err");
  }
  refresh();
});

$("stop").addEventListener("click", async () => {
  await command("stopNode").catch((e) => setMsg(e.message, "err"));
  refresh();
});

$("copy-node").addEventListener("click", async () => {
  const t = $("nodeid").textContent || "";
  if (t) await navigator.clipboard.writeText(t);
  setMsg("Node ID copied", "ok");
});

$("export").addEventListener("click", async () => {
  try {
    const env = await command<string>("exportBackup");
    const out = $<HTMLTextAreaElement>("backup-out");
    out.value = env;
    show(out, true);
    await navigator.clipboard.writeText(env).catch(() => {});
    setMsg("Backup exported & copied. Store it safely.", "ok");
  } catch (e: any) {
    setMsg(e.message, "err");
  }
});

// ---- setup: create ----
$("new-btn").addEventListener("click", () => {
  $("seed").textContent = randomSeedHex();
  show($("create-panel"), true);
  show($("restore-panel"), false);
});

$("saved").addEventListener("change", (e) => {
  ($("create-confirm") as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked;
});

$("create-confirm").addEventListener("click", async () => {
  setMsg("Creating wallet & starting node…");
  try {
    await command("createWallet", { seedHex: $("seed").textContent });
    setMsg("Wallet created", "ok");
    refresh();
  } catch (e: any) {
    setMsg(e.message, "err");
  }
});

// ---- setup: restore ----
$("restore-btn").addEventListener("click", () => {
  show($("restore-panel"), true);
  show($("create-panel"), false);
});

$("restore-confirm").addEventListener("click", async () => {
  setMsg("Restoring…");
  try {
    await command("restoreWallet", {
      envelope: $<HTMLTextAreaElement>("restore-env").value.trim(),
      secret: $<HTMLInputElement>("restore-secret").value.trim(),
    });
    setMsg("Wallet restored", "ok");
    refresh();
  } catch (e: any) {
    setMsg(e.message, "err");
  }
});

$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

onWalletEvent(() => refresh());
refresh();
