import QRCode from "qrcode";
import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { confirmModal } from "../ui/confirm-modal";
import { channelCountLabel } from "../core/stat-format";
import { AUTO_START_KEY, isAutoStartEnabled } from "../core/auto-start";
import { driveRestore } from "../drive-integration";
import {
  parseBudgetRenewal,
  parseMaxAmount,
  buildAllowedMethods,
  expiryFromDays,
  isChannelStateRegressionError,
  isNodeAlreadyRunningError,
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

export function initHome(ctx: AppContext): void {
  const controller = ctx.controller;
  let running = false;
  // Latch set when start() throws a channel-state regression: refresh() would otherwise re-hide
  // the restore panel (it only shows setup-view when there's no wallet, but a regression means a
  // wallet DOES exist) — so refresh() must re-assert the restore view while this is true.
  let needsRestore = false;

  async function refresh() {
    try {
      const s = await controller.getState();
      running = !!s.running;
      $("net").textContent = s.network;
      $("dot").classList.toggle("on", running);

      const hasWallet = s.hasSeed || s.createdNew || s.hasChannelState;
      show($("wallet-view"), hasWallet);
      show($("setup-view"), !hasWallet);
      if (needsRestore) {
        show($("setup-view"), true);
        show($("wallet-view"), false);
        show($("create-panel"), false);
        show($("restore-panel"), true);
      }

      const line = $("status-line");
      line.classList.toggle("on", running);
      if (!hasWallet) line.textContent = "No wallet — create one to begin";
      else if (running) line.textContent = "Node running";
      else line.textContent = "Node stopped — tap Start";

      if (hasWallet) {
        $("spendable").textContent = s.balance ? `${s.balance.spendableSat} sat` : "—";
        $("receivable").textContent = s.balance ? `${s.balance.receivableSat} sat` : "—";
        $("channels").textContent = channelCountLabel(s.channels, s.usableChannels);
        $("peers").textContent = s.peers != null ? String(s.peers) : "—";
        $("nodeid").textContent = s.nodeId || "(start the node to load)";
        show($("start"), !running);
        show($("stop"), running);
        for (const id of ["create-invoice", "create-nwc"]) {
          ($(id) as HTMLButtonElement).disabled = !running;
        }
        if (running) void refreshNwcList();
      }
    } catch (e) {
      setMsg("msg", (e as Error).message, "err");
    }
  }

  // ---- lifecycle ----
  $("start").addEventListener("click", async () => {
    setMsg("msg", "Starting node…");
    try {
      await controller.startNode();
      needsRestore = false;
      setMsg("msg", "Node started", "ok");
    } catch (e) {
      if (isChannelStateRegressionError(e)) {
        needsRestore = true;
        show($("setup-view"), true);
        show($("wallet-view"), false);
        show($("create-panel"), false);
        show($("restore-panel"), true);
        setMsg(
          "restore-msg",
          "This wallet's channel state is behind what it durably reached — starting now would force-close your channels. Restore from your latest backup to continue.",
          "err"
        );
        return; // skip the trailing refresh() so the panel isn't re-hidden
      }
      if (isNodeAlreadyRunningError(e)) {
        setMsg("msg", "This wallet is already running in another tab or window — close it and try again.", "err");
        return;
      }
      setMsg("msg", (e as Error).message, "err");
    }
    void refresh();
  });

  $("stop").addEventListener("click", async () => {
    await controller.stopNode().catch((e) => setMsg("msg", (e as Error).message, "err"));
    void refresh();
  });

  $("copy-node").addEventListener("click", async () => {
    const t = $("nodeid").textContent || "";
    if (t) await navigator.clipboard.writeText(t).catch(() => {});
    setMsg("msg", "Node ID copied — paste into your node's openchannel", "ok");
  });

  // ---- receive (top up) ----
  $("create-invoice").addEventListener("click", async () => {
    setMsg("receive-msg", "Creating invoice…");
    show($("invoice-qr"), false);
    try {
      const { paymentRequest } = await controller.createInvoice(
        Number(($("invoice-amount") as HTMLInputElement).value),
        ($("invoice-memo") as HTMLInputElement).value.trim()
      );
      const out = $<HTMLTextAreaElement>("invoice-out");
      out.value = paymentRequest;
      show(out, true);
      show($("copy-invoice"), true);
      try {
        const qr = $<HTMLImageElement>("invoice-qr");
        qr.src = await QRCode.toDataURL(paymentRequest, { width: 220, margin: 1 });
        show(qr, true);
      } catch (qrErr) {
        console.warn("[Receive] could not render invoice QR:", (qrErr as Error)?.message || qrErr);
      }
      setMsg("receive-msg", "Invoice ready — scan or pay it from another wallet to top up", "ok");
    } catch (e) {
      setMsg("receive-msg", (e as Error).message, "err");
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
      const { uri } = await controller.nwcCreateConnection(
        ($("nwc-name") as HTMLInputElement).value.trim() || "Nostr Client App",
        {
          spendingLimitSats: Number(($("nwc-limit") as HTMLInputElement).value) || 0,
          budgetRenewal: parseBudgetRenewal(($("nwc-renewal") as HTMLSelectElement).value),
          maxAmountSats: maxRes.value,
          allowedMethods,
          expiresAt: expiryFromDays(parseInt(($("nwc-expiry") as HTMLSelectElement).value, 10) || 0, Date.now()),
        }
      );
      const out = $<HTMLTextAreaElement>("nwc-out");
      out.value = uri;
      show(out, true);
      show($("copy-nwc"), true);
      // Render the pairing QR on-device (bundled qrcode) — the URI embeds the spend secret, so it
      // must NEVER go to a third-party QR image service.
      setMsg("nwc-msg", "Pairing created — paste it into your nostr app", "ok");
      void refreshNwcList();
    } catch (e) {
      setMsg("nwc-msg", (e as Error).message, "err");
    }
  });
  $("copy-nwc").addEventListener("click", async () => {
    await navigator.clipboard.writeText($<HTMLTextAreaElement>("nwc-out").value).catch(() => {});
    setMsg("nwc-msg", "Connection URI copied", "ok");
  });

  async function refreshNwcList() {
    const list = await controller.nwcListConnections().catch((e) => {
      console.warn("[Home] nwcListConnections failed:", (e as Error)?.message || e);
      return [] as Awaited<ReturnType<typeof controller.nwcListConnections>>;
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
      btn.className = "btn ghost small";
      btn.addEventListener("click", async () => {
        const ok = await confirmModal({
          title: "Revoke pairing?",
          body: `Delete the NWC pairing “${c.name}”? Any app using it will lose access to this wallet.`,
          confirmLabel: "Revoke",
          danger: true,
        });
        if (!ok) return;
        await controller.nwcDeleteConnection(c.clientPubkey).catch((e) => setMsg("nwc-msg", (e as Error).message, "err"));
        void refreshNwcList();
      });
      item.append(nm, btn);
      box.appendChild(item);
    }
  }

  // ---- auto-start toggle (localStorage) ----
  ($("auto-start") as HTMLInputElement).checked = isAutoStartEnabled(localStorage.getItem(AUTO_START_KEY));
  $("auto-start").addEventListener("change", (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    localStorage.setItem(AUTO_START_KEY, enabled ? "1" : "0");
    setMsg("msg", enabled ? "Auto-start on — the node starts when you open the app." : "Auto-start off.", "ok");
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
    const own = ($("seed-input") as HTMLInputElement).value.trim();
    const seedHex = own || ($("seed").textContent || "");
    if (own && !/^[0-9a-fA-F]{64}$/.test(own)) {
      setMsg("create-msg", "That seed isn't valid — it must be 64 hex characters (32 bytes).", "err");
      return;
    }
    // FORCE-CLOSE GUARD: creating with a pasted seed starts a FRESH, EMPTY node. If that seed
    // already has a channel, connecting the peer force-closes it — a funded wallet must come back
    // via Restore from backup.
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
      await controller.createWallet({ seedHex });
      setMsg("msg", "Wallet created", "ok");
      void refresh();
    } catch (e) {
      setMsg("msg", (e as Error).message, "err");
    }
  });

  // ---- setup: restore ----
  $("restore-btn").addEventListener("click", () => {
    show($("restore-panel"), true);
    show($("create-panel"), false);
  });
  $("restore-confirm").addEventListener("click", async () => {
    const envelope = $<HTMLTextAreaElement>("restore-env").value.trim();
    const secret = ($("restore-secret") as HTMLInputElement).value.trim();
    if (!envelope) {
      setMsg("restore-msg", "Paste your encrypted backup JSON — a seed alone can't restore channels.", "err");
      return;
    }
    if (!secret) {
      setMsg("restore-msg", "Enter your recovery seed (it decrypts the backup).", "err");
      return;
    }
    setMsg("restore-msg", "Restoring…");
    try {
      await controller.restoreWallet(envelope, secret);
      setMsg("restore-msg", "Wallet restored", "ok");
      void refresh();
    } catch (e) {
      setMsg("restore-msg", (e as Error).message, "err");
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
      const envelope = (await file.text()).trim();
      if (!envelope) {
        setMsg("restore-msg", "That file is empty.", "err");
        return;
      }
      setMsg("restore-msg", "Restoring…");
      await controller.restoreWallet(envelope, secret);
      setMsg("restore-msg", "Wallet restored", "ok");
      void refresh();
    } catch (e) {
      setMsg("restore-msg", (e as Error).message, "err");
    }
  });
  $("restore-drive").addEventListener("click", async () => {
    const secret = ($("restore-secret") as HTMLInputElement).value.trim();
    if (!secret) {
      setMsg("restore-msg", "Enter your recovery seed first.", "err");
      return;
    }
    setMsg("restore-msg", "Fetching backup from Google Drive…");
    try {
      await driveRestore(controller, secret);
      setMsg("restore-msg", "Wallet restored from Drive", "ok");
      void refresh();
    } catch (e) {
      setMsg("restore-msg", (e as Error).message, "err");
    }
  });

  onControllerEvent(() => void refresh());
  void refresh();
  // Peer connects/drops emit no wallet events (only channel-state persists do) — poll while open.
  setInterval(() => void refresh(), 5000);
}
