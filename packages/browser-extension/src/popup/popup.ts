import QRCode from "qrcode";
import { command, onWalletEvent } from "../ui/rpc";
import { confirmModal } from "../ui/confirm-modal";
import {
  parseBudgetRenewal,
  parseMaxAmount,
  buildAllowedMethods,
  expiryFromDays,
} from "@libre/shared";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (el: HTMLElement, on: boolean) => el.classList.toggle("hidden", !on);
const setMsg = (id: string, text: string, kind: "" | "ok" | "err" = "") => {
  const m = $(id);
  m.textContent = text;
  m.className = `msg ${kind}`;
};

function randomSeedHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let running = false;

async function refresh() {
  try {
    const s = await command<any>("getState");
    running = !!s.running;
    $("net").textContent = s.network;
    $("dot").classList.toggle("on", running);

    const hasWallet = s.hasSeed || s.createdNew || s.hasChannelState;
    show($("wallet-view"), hasWallet);
    show($("setup-view"), !hasWallet);

    const line = $("status-line");
    line.classList.toggle("on", running);
    if (!hasWallet) line.textContent = "No wallet — create one to begin";
    else if (running) line.textContent = "Node running";
    else line.textContent = "Node stopped — click Start";

    if (hasWallet) {
      $("spendable").textContent = s.balance ? `${s.balance.spendableSat} sat` : "—";
      $("receivable").textContent = s.balance ? `${s.balance.receivableSat} sat` : "—";
      $("channels").textContent = s.channels ?? "—";
      $("peers").textContent = s.peers ?? "—";
      $("nodeid").textContent = s.nodeId || "(start the node to load)";
      show($("start"), !running);
      show($("stop"), running);
      // Actions that require a live node.
      for (const id of ["create-invoice", "create-nwc"]) {
        ($(id) as HTMLButtonElement).disabled = !running;
      }
      if (running) {
        void refreshNwcList();
      }
      void refreshAutoStart();
    }
  } catch (e: any) {
    setMsg("msg", e.message, "err");
  }
}

// ---- lifecycle ----
$("start").addEventListener("click", async () => {
  setMsg("msg", "Starting node…");
  try {
    await command("startNode");
    setMsg("msg", "Node started", "ok");
  } catch (e: any) {
    setMsg("msg", e.message, "err");
  }
  void refresh();
});

$("stop").addEventListener("click", async () => {
  await command("stopNode").catch((e) => setMsg("msg", e.message, "err"));
  void refresh();
});

$("copy-node").addEventListener("click", async () => {
  const t = $("nodeid").textContent || "";
  if (t) await navigator.clipboard.writeText(t);
  setMsg("msg", "Node ID copied — paste into your node's openchannel", "ok");
});

// ---- top up: create a receive invoice ----
$("create-invoice").addEventListener("click", async () => {
  setMsg("receive-msg", "Creating invoice…");
  show($("invoice-qr"), false); // never leave a stale QR up while the new invoice is created
  try {
    const { paymentRequest } = await command<{ paymentRequest: string }>("createInvoice", {
      amountSats: Number(($("invoice-amount") as HTMLInputElement).value),
      memo: ($("invoice-memo") as HTMLInputElement).value.trim(),
    });
    const out = $<HTMLTextAreaElement>("invoice-out");
    out.value = paymentRequest;
    show(out, true);
    show($("copy-invoice"), true);
    // Render the QR locally (bundled qrcode) — never via a QR image service, same rule as the
    // PWA's NWC QR. Best-effort: the textarea + copy button are the fallback if rendering fails.
    try {
      const qr = $<HTMLImageElement>("invoice-qr");
      qr.src = await QRCode.toDataURL(paymentRequest, { width: 190, margin: 1 });
      show(qr, true);
    } catch (qrErr: any) {
      console.warn("[Receive] could not render invoice QR:", qrErr?.message || qrErr);
    }
    setMsg("receive-msg", "Invoice ready — scan it or pay it from another wallet to top up", "ok");
  } catch (e: any) {
    setMsg("receive-msg", e.message, "err");
  }
});
$("copy-invoice").addEventListener("click", async () => {
  await navigator.clipboard.writeText($<HTMLTextAreaElement>("invoice-out").value).catch(() => {});
  setMsg("receive-msg", "Invoice copied", "ok");
});

// ---- NWC pairing ----
$("create-nwc").addEventListener("click", async () => {
  setMsg("nwc-msg", "Creating pairing…");
  try {
    // Optional spending controls (mirrors the PWA form). Blank/all-checked keep the
    // permissive legacy shape; a bad per-payment cap is a hard error, never silently ignored.
    const maxRes = parseMaxAmount(($("nwc-max") as HTMLInputElement).value);
    if (!maxRes.ok) {
      setMsg("nwc-msg", maxRes.error, "err");
      return;
    }
    const allowedMethods = buildAllowedMethods({
      pay_invoice: ($("nwc-m-pay_invoice") as HTMLInputElement).checked,
      pay_keysend: ($("nwc-m-pay_keysend") as HTMLInputElement).checked,
      make_invoice: ($("nwc-m-make_invoice") as HTMLInputElement).checked,
      get_balance: ($("nwc-m-get_balance") as HTMLInputElement).checked,
    });
    const { uri } = await command<{ uri: string }>("nwcCreateConnection", {
      name: ($("nwc-name") as HTMLInputElement).value.trim() || "Nostr Client App",
      spendingLimitSats: Number(($("nwc-limit") as HTMLInputElement).value) || 0,
      budgetRenewal: parseBudgetRenewal(($("nwc-renewal") as HTMLSelectElement).value),
      maxAmountSats: maxRes.value,
      allowedMethods,
      expiresAt: expiryFromDays(parseInt(($("nwc-expiry") as HTMLSelectElement).value, 10) || 0, Date.now()),
    });
    const out = $<HTMLTextAreaElement>("nwc-out");
    out.value = uri;
    show(out, true);
    show($("copy-nwc"), true);
    setMsg("nwc-msg", "Pairing created — paste it into your nostr app", "ok");
    void refreshNwcList();
  } catch (e: any) {
    setMsg("nwc-msg", e.message, "err");
  }
});
$("copy-nwc").addEventListener("click", async () => {
  await navigator.clipboard.writeText($<HTMLTextAreaElement>("nwc-out").value).catch(() => {});
  setMsg("nwc-msg", "Connection URI copied", "ok");
});

async function refreshNwcList() {
  const list = await command<any[]>("nwcListConnections").catch((e) => {
    console.warn("[Popup] nwcListConnections failed:", e?.message || e);
    return [];
  });
  const box = $("nwc-list");
  box.innerHTML = "";
  for (const c of list) {
    const cap = c.spendingLimitSats > 0 ? `${c.spentTodaySats ?? 0}/${c.spendingLimitSats} sat` : "no cap";
    const item = document.createElement("div");
    item.className = "nwc-item";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = `${c.name} · ${cap}`;
    const btn = document.createElement("button");
    btn.textContent = "Revoke";
    btn.className = "ghost";
    btn.style.padding = "3px 8px";
    btn.addEventListener("click", async () => {
      const ok = await confirmModal({
        title: "Revoke pairing?",
        body: `Delete the NWC pairing “${c.name}”? Any app using it will lose access to this wallet.`,
        confirmLabel: "Revoke",
        danger: true,
      });
      if (!ok) return;
      await command("nwcDeleteConnection", { clientPubkey: c.clientPubkey }).catch((e) =>
        setMsg("nwc-msg", e.message, "err")
      );
      void refreshNwcList();
    });
    item.append(nm, btn);
    box.appendChild(item);
  }
}

// Auto-start toggle: persisted in the background (chrome.storage.local), default ON.
async function refreshAutoStart() {
  const on = await command<boolean>("getAutoStart").catch(() => true);
  ($("auto-start") as HTMLInputElement).checked = !!on;
}
$("auto-start").addEventListener("change", async (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  await command("setAutoStart", { enabled }).catch((err) => setMsg("msg", err.message, "err"));
  setMsg("msg", enabled ? "Auto-start on — the node starts with the browser." : "Auto-start off.", "ok");
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
  // Use a seed the user pasted (bringing back a saved seed), otherwise the freshly generated one.
  const own = ($("seed-input") as HTMLInputElement).value.trim();
  const seedHex = own || ($("seed").textContent || "");
  if (own && !/^[0-9a-fA-F]{64}$/.test(own)) {
    setMsg("create-msg", "That seed isn't valid — it must be 64 hex characters (32 bytes).", "err");
    return;
  }
  // FORCE-CLOSE GUARD: creating with a pasted seed starts a FRESH, EMPTY node (marked
  // wallet_created_new so it's allowed to start). If that seed already has a channel, connecting the
  // peer will force-close it (empty node → "unknown channel" on channel_reestablish). Only safe for
  // a seed that has never been funded — a funded wallet must come back via Restore-from-backup.
  if (own) {
    const ok = await confirmModal({
      title: "Only for a seed that has no channel",
      body:
        "Creating with a seed starts a brand-new, EMPTY wallet. If this seed already has a channel " +
        "or a backup, this will FORCE-CLOSE that channel once you connect. To bring back a funded " +
        "wallet, cancel and use Restore from backup instead.",
      confirmLabel: "This seed has no channel — create",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
  }
  setMsg("create-msg", "");
  setMsg("msg", "Creating wallet & starting node…");
  try {
    await command("createWallet", { seedHex });
    setMsg("msg", "Wallet created", "ok");
    void refresh();
  } catch (e: any) {
    setMsg("msg", e.message, "err");
  }
});

// ---- setup: restore ----
$("restore-btn").addEventListener("click", () => {
  show($("restore-panel"), true);
  show($("create-panel"), false);
});

$("restore-drive").addEventListener("click", async () => {
  const secret = ($("restore-secret") as HTMLInputElement).value.trim();
  if (!secret) {
    setMsg("restore-msg", "Enter your recovery seed first.", "err");
    return;
  }
  setMsg("restore-msg", "Fetching backup from Google Drive…");
  try {
    await command("driveRestore", { secret });
    setMsg("restore-msg", "Wallet restored from Drive", "ok");
    void refresh();
  } catch (e: any) {
    setMsg("restore-msg", e.message, "err");
  }
});

$("restore-file-btn").addEventListener("click", async () => {
  const file = $<HTMLInputElement>("restore-file").files?.[0];
  const secret = ($("restore-secret") as HTMLInputElement).value.trim();
  if (!file) {
    setMsg("restore-msg", "Choose your backup .json file first.", "err");
    return;
  }
  if (!secret) {
    setMsg("restore-msg", "Enter your recovery seed (it decrypts the backup).", "err");
    return;
  }
  setMsg("restore-msg", "Reading backup file…");
  try {
    // Read the (potentially large) envelope straight from the file — no giant copy/paste needed.
    const envelope = (await file.text()).trim();
    if (!envelope) {
      setMsg("restore-msg", "That file is empty.", "err");
      return;
    }
    setMsg("restore-msg", "Restoring…");
    await command("restoreWallet", { envelope, secret });
    setMsg("restore-msg", "Wallet restored", "ok");
    void refresh();
  } catch (e: any) {
    setMsg("restore-msg", e.message, "err");
  }
});

$("restore-confirm").addEventListener("click", async () => {
  const envelope = $<HTMLTextAreaElement>("restore-env").value.trim();
  const secret = ($("restore-secret") as HTMLInputElement).value.trim();
  if (!envelope) {
    setMsg("restore-msg", "Paste your encrypted backup JSON above — a seed alone can't restore channels.", "err");
    return;
  }
  if (!secret) {
    setMsg("restore-msg", "Enter your recovery seed (it decrypts the backup).", "err");
    return;
  }
  setMsg("restore-msg", "Restoring…");
  try {
    await command("restoreWallet", { envelope, secret });
    setMsg("restore-msg", "Wallet restored", "ok");
    void refresh();
  } catch (e: any) {
    setMsg("restore-msg", e.message, "err");
  }
});

$("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

onWalletEvent(() => refresh());
void refresh();
