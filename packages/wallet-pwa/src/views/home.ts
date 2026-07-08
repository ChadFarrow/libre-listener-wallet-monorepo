import QRCode from "qrcode";
import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { confirmModal } from "../ui/confirm-modal";
import { channelCountLabel } from "../core/stat-format";
import { parseNwcLimit } from "../core/nwc-limit";
import { AUTO_START_KEY, isAutoStartEnabled } from "../core/auto-start";
import { computeChecklist, getSeedBackedUp, setSeedBackedUp } from "../core/onboarding";
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

// Switch tabs (via the global wired in main.ts) and scroll a target card into view. Used by the
// onboarding checklist to deep-link the buried Settings actions (recovery phrase, get-a-channel).
function goTo(tab: string, elId: string): void {
  (window as unknown as { showTab?: (t: string) => void }).showTab?.(tab);
  requestAnimationFrame(() => document.getElementById(elId)?.scrollIntoView({ behavior: "smooth", block: "start" }));
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

        // Guided setup checklist + the "you need a channel to receive" hint.
        const checklist = computeChecklist({
          hasWallet: true,
          backedUp: getSeedBackedUp(s.network),
          running,
          channels: s.channels ?? 0,
          usableChannels: s.usableChannels ?? 0,
        });
        renderChecklist(checklist);
        show($("receive-hint"), running && (s.balance?.receivableSat ?? 0) === 0);
      }
    } catch (e) {
      setMsg("msg", (e as Error).message, "err");
    }
  }

  function renderChecklist(cl: ReturnType<typeof computeChecklist>): void {
    show($("onboarding-checklist"), cl.visible);
    if (!cl.visible) return;
    const list = $("checklist-items");
    list.innerHTML = "";
    for (const it of cl.items) {
      const li = document.createElement("li");
      li.className = `checklist-item ${it.done ? "done" : it.active ? "active" : "upcoming"}`;
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = it.done ? "✓" : "";
      const body = document.createElement("div");
      body.className = "body";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = it.label;
      body.appendChild(label);
      if (it.note) {
        const note = document.createElement("span");
        note.className = "note";
        note.textContent = it.note;
        body.appendChild(note);
      }
      if (it.active && it.actionLabel) {
        const btn = document.createElement("button");
        btn.className = "btn primary small";
        btn.textContent = it.actionLabel;
        btn.disabled = !!it.actionDisabled;
        btn.addEventListener("click", () => {
          if (it.key === "backup") goTo("settings", "recovery-card");
          else if (it.key === "start") void startNode();
          else if (it.key === "channel") goTo("settings", "lsps1-card");
        });
        body.appendChild(btn);
      }
      li.append(mark, body);
      list.appendChild(li);
    }
  }

  // ---- lifecycle ----
  async function startNode(): Promise<void> {
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
  }
  $("start").addEventListener("click", () => void startNode());

  $("stop").addEventListener("click", async () => {
    await controller.stopNode().catch((e) => setMsg("msg", (e as Error).message, "err"));
    void refresh();
  });

  $("copy-node").addEventListener("click", async () => {
    // Only report success for a REAL node id (the node is running) that actually copied — the
    // display text can be a "(start the node)" placeholder, and clipboard writes can reject.
    const s = await controller.getState().catch(() => null);
    const id = s?.nodeId;
    if (!id) {
      setMsg("msg", "Start the node first — there's no Node ID to copy yet.", "err");
      return;
    }
    try {
      await navigator.clipboard.writeText(id);
      setMsg("msg", "Node ID copied — paste into your node's openchannel", "ok");
    } catch {
      setMsg("msg", "Couldn't copy to the clipboard — select the Node ID and copy it manually.", "err");
    }
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
    // Guard against a double-tap minting two live pairings (two spend secrets) before the first
    // resolves. Disabled for the whole async handler; re-enabled in finally.
    const nwcBtn = $<HTMLButtonElement>("create-nwc");
    if (nwcBtn.disabled) return;
    nwcBtn.disabled = true;
    setMsg("nwc-msg", "Creating pairing…");
    try {
      const maxRes = parseMaxAmount(($("nwc-max") as HTMLInputElement).value);
      if (!maxRes.ok) {
        setMsg("nwc-msg", maxRes.error, "err");
        return;
      }
      // Strict daily-limit parse — blank/NaN must NOT collapse to 0 (= unlimited).
      const limitRes = parseNwcLimit(($("nwc-limit") as HTMLInputElement).value);
      if (!limitRes.ok) {
        setMsg("nwc-msg", limitRes.error, "err");
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
          spendingLimitSats: limitRes.value,
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
    } finally {
      nwcBtn.disabled = false;
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
    // Disable for the whole async handler (incl. the confirm modal + createWallet) so a double-tap
    // can't kick off two creates; re-enabled in finally.
    const createBtn = $<HTMLButtonElement>("create-confirm");
    if (createBtn.disabled) return;
    createBtn.disabled = true;
    try {
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
    } finally {
      createBtn.disabled = false;
    }
  });

  // ---- setup: restore ----
  // A successful restore means the user already holds a backup — tick the checklist's backup step.
  async function markBackedUp(): Promise<void> {
    const st = await controller.getState().catch(() => null);
    if (st) setSeedBackedUp(st.network);
  }
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
      void markBackedUp();
      void refresh();
    } catch (e) {
      if (isNodeAlreadyRunningError(e)) {
        setMsg("restore-msg", "This wallet is already running in another tab or window — close it and try again.", "err");
        return;
      }
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
      void markBackedUp();
      void refresh();
    } catch (e) {
      if (isNodeAlreadyRunningError(e)) {
        setMsg("restore-msg", "This wallet is already running in another tab or window — close it and try again.", "err");
        return;
      }
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
      void markBackedUp();
      void refresh();
    } catch (e) {
      if (isNodeAlreadyRunningError(e)) {
        setMsg("restore-msg", "This wallet is already running in another tab or window — close it and try again.", "err");
        return;
      }
      setMsg("restore-msg", (e as Error).message, "err");
    }
  });

  onControllerEvent(() => void refresh());
  void refresh();
  // Peer connects/drops emit no wallet events (only channel-state persists do) — poll while open.
  setInterval(() => void refresh(), 5000);
}
