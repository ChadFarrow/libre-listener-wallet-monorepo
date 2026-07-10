import QRCode from "qrcode";
import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { confirmModal } from "../ui/confirm-modal";
import { channelCountLabel } from "../core/stat-format";
import { parseNwcLimit } from "../core/nwc-limit";
import { AUTO_START_KEY, isAutoStartEnabled } from "../core/auto-start";
import { computeChecklist, getSeedBackedUp, setSeedBackedUp } from "../core/onboarding";
import { resolveSeedInput } from "../core/seed-input";
import { guardedClick } from "../core/ui-helpers";
import { formatOpeningFee } from "../core/lsps1-provider-ui";
import { driveRestore, driveConfigured, ensureDriveConnected, driveBackupNow } from "../drive-integration";
import {
  parseBudgetRenewal,
  parseMaxAmount,
  buildAllowedMethods,
  expiryFromDays,
  isChannelStateRegressionError,
  isNodeAlreadyRunningError,
  LSPS1_REST_PROVIDERS,
  lsps1OrderStatus,
  type Lsps1RestOrderResponse,
} from "@libre/shared";
import { withMockProvider, quickChannelProvider } from "../core/lsps1-mock-provider";

// Dev-only mock LSP (VITE_LSPS1_MOCK_URL in .env.local) — identical to LSPS1_REST_PROVIDERS in prod.
const LSPS1_PROVIDERS = withMockProvider(LSPS1_REST_PROVIDERS, import.meta.env.VITE_LSPS1_MOCK_URL);

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

// Switch to a tab (via the global wired in main.ts). No-op in unit tests where main.ts isn't loaded.
function goToTab(tab: string): void {
  (window as unknown as { showTab?: (t: string) => void }).showTab?.(tab);
}
// Switch tabs and scroll a target card into view. Used by the onboarding checklist to reach the
// Settings actions (recovery phrase, get-a-channel) that live on the Settings tab.
function goTo(tab: string, elId: string): void {
  goToTab(tab);
  requestAnimationFrame(() => document.getElementById(elId)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

export function initHome(ctx: AppContext): void {
  const controller = ctx.controller;
  let running = false;
  // Latch set when start() throws a channel-state regression: refresh() would otherwise re-hide
  // the restore panel (it only shows setup-view when there's no wallet, but a regression means a
  // wallet DOES exist) — so refresh() must re-assert the restore view while this is true.
  let needsRestore = false;
  // On the very first refresh, land the user on the right tab: Create when there's no wallet yet,
  // otherwise stay on Wallet. Only done once so it never fights the user's manual tab choice.
  let initialTabSet = false;

  async function refresh() {
    try {
      const s = await controller.getState();
      running = !!s.running;
      $("net").textContent = s.network;
      $("dot").classList.toggle("on", running);

      const hasWallet = s.hasSeed || s.createdNew || s.hasChannelState;
      show($("wallet-view"), hasWallet);
      show($("no-wallet-note"), !hasWallet);
      show($("setup-view"), !hasWallet);
      if (!initialTabSet) {
        initialTabSet = true;
        if (!hasWallet) goToTab("create");
      }
      if (needsRestore) {
        goToTab("create");
        setSetupChoice("restore");
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

        // Guided setup checklist (Create tab) + the "you need a channel to receive" hint (Wallet tab).
        const checklist = computeChecklist({
          hasWallet: true,
          backedUp: getSeedBackedUp(s.network),
          cloudBackup: driveConfigured(),
          running,
          channels: s.channels ?? 0,
          usableChannels: s.usableChannels ?? 0,
        });
        renderChecklist(checklist);
        // Surface a node-start failure right in the checklist (auto-start swallows it to a console
        // log otherwise, so it looks like the node "just didn't start"). Cleared once running.
        if (!running && s.startError) {
          setMsg("checklist-msg", `The node didn't start: ${s.startError}`, "err");
        } else {
          setMsg("checklist-msg", "");
        }
        // When setup is complete (checklist hidden) the Create tab shows an "all set" card instead —
        // but never while we're forcing the restore panel there.
        show($("create-complete"), !checklist.visible && !needsRestore);
        show($("receive-hint"), running && (s.balance?.receivableSat ?? 0) === 0);
      } else {
        show($("onboarding-checklist"), false);
        show($("create-complete"), false);
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
          else if (it.key === "cloudBackup") void connectCloudBackup();
          else if (it.key === "start") void startNode();
          else if (it.key === "channel") void orderQuickChannel();
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
        goToTab("create");
        setSetupChoice("restore");
        show($("setup-view"), true);
        show($("wallet-view"), false);
        show($("create-panel"), false);
        show($("restore-panel"), true);
        show($("create-complete"), false);
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
  // guardedClick: a double-tap must not mint two live pairings (two spend secrets).
  guardedClick($<HTMLButtonElement>("create-nwc"), async () => {
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

  // The two "Get started" buttons act as a toggle: the active choice's button is green (primary),
  // the other reverts to ghost — so it's clear which panel is showing.
  function setSetupChoice(which: "create" | "restore"): void {
    $("new-btn").classList.toggle("primary", which === "create");
    $("new-btn").classList.toggle("ghost", which !== "create");
    $("restore-btn").classList.toggle("primary", which === "restore");
    $("restore-btn").classList.toggle("ghost", which !== "restore");
  }

  // ---- setup: create ----
  $("new-btn").addEventListener("click", () => {
    $("seed").textContent = randomSeedHex();
    setSetupChoice("create");
    show($("create-panel"), true);
    show($("restore-panel"), false);
  });
  $("saved").addEventListener("change", (e) => {
    ($("create-confirm") as HTMLButtonElement).disabled = !(e.target as HTMLInputElement).checked;
  });
  // guardedClick: disabled for the whole handler (incl. the confirm modal + createWallet) so a
  // double-tap can't kick off two creates.
  guardedClick($<HTMLButtonElement>("create-confirm"), async () => {
    // Create is always a brand-new, freshly generated seed. Bringing back an existing wallet is a
    // Restore action (needs the backup envelope), so there's no pasted-seed path here anymore.
    const seedHex = $("seed").textContent || "";
    setMsg("create-msg", "Creating wallet & starting node…");
    setMsg("msg", "Creating wallet & starting node…");
    // The user ticked "I've saved my recovery seed" (required to create), so mark the backup step
    // done NOW — up front, independent of whether the node manages to start. createWallet writes the
    // seed before it starts the node, so if start fails (e.g. a flaky mainnet esplora) the wallet
    // still exists and the seed is still what they saved; the mark must not be lost to that failure.
    const pre = await controller.getState().catch(() => null);
    if (pre) setSeedBackedUp(pre.network);
    try {
      const res = await controller.createWallet({ seedHex });
      setSeedBackedUp(res.network);
      setMsg("create-msg", "");
      setMsg("msg", "Wallet created", "ok");
      void refresh();
    } catch (e) {
      // The seed is saved even though the node didn't start. refresh() will hide the create panel
      // (a wallet now exists), so the create-tab message would vanish — take the user to the Wallet
      // tab where the node controls + message box are visible, and surface the reason there so they
      // can tap Start to retry.
      setMsg("msg", `Wallet saved, but the node didn't start: ${(e as Error).message}. Tap Start to try again.`, "err");
      setMsg("create-msg", "");
      goToTab("home");
      void refresh();
    }
  });

  // ---- setup: restore ----
  // A successful restore means the user already holds a backup — tick the checklist's backup step.
  async function markBackedUp(): Promise<void> {
    const st = await controller.getState().catch(() => null);
    if (st) setSeedBackedUp(st.network);
  }
  $("restore-btn").addEventListener("click", () => {
    setSetupChoice("restore");
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
      goToTab("home");
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
      goToTab("home");
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
      goToTab("home");
      void refresh();
    } catch (e) {
      if (isNodeAlreadyRunningError(e)) {
        setMsg("restore-msg", "This wallet is already running in another tab or window — close it and try again.", "err");
        return;
      }
      setMsg("restore-msg", (e as Error).message, "err");
    }
  });

  // Seed-only restore: no backup file, just the 24-word phrase or 64-hex seed. This brings back an
  // EMPTY wallet (channels need a backup) — the same fresh-node path as createWallet, so it carries
  // the force-close guard. guardedClick: a double-tap must not kick off two creates.
  guardedClick($<HTMLButtonElement>("restore-seed-only"), async () => {
    const raw = ($("restore-secret") as HTMLInputElement).value.trim();
    if (!raw) {
      setMsg("restore-msg", "Enter your recovery seed — a 24-word phrase or a 64-hex seed.", "err");
      return;
    }
    const seedHex = resolveSeedInput(raw);
    if (!seedHex) {
      setMsg("restore-msg", "That isn't a valid recovery seed (24 words or 64 hex).", "err");
      return;
    }
    // FORCE-CLOSE GUARD: a seed that already has a channel can't come back this way — importing it
    // starts a fresh EMPTY node, and connecting the peer force-closes the real channel. A funded
    // wallet must be restored from its backup file (which recovers the channels) instead.
    const ok = await confirmModal({
      title: "Only for a seed with no channel",
      body:
        "Restoring with just a seed starts a brand-new, EMPTY wallet. If this seed already has a " +
        "channel, this will FORCE-CLOSE it once you connect. To bring back a funded wallet, cancel " +
        "and restore from your backup file instead.",
      confirmLabel: "This seed has no channel — restore",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    setMsg("restore-msg", "Restoring from seed…");
    try {
      await controller.createWallet({ seedHex });
      setMsg("restore-msg", "Wallet restored from seed", "ok");
      void markBackedUp();
      goToTab("home");
      void refresh();
    } catch (e) {
      if (isNodeAlreadyRunningError(e)) {
        setMsg("restore-msg", "This wallet is already running in another tab or window — close it and try again.", "err");
        return;
      }
      setMsg("restore-msg", (e as Error).message, "err");
    }
  });

  // ---- one-tap "Get a channel" ----
  // The checklist's Get-a-channel step places a FIXED order — 150k sats, ~3-month lease, from
  // Megalith — and shows the pay QR right here, so the user never has to open Settings and pick a
  // provider/amount/lease. Placing the order only fetches a quote + invoice; nothing is spent until
  // they pay it. Megalith is the 150k-minimum, instant-0-conf mainnet LSP.
  const QUICK_CHANNEL_SATS = 150000;
  const QUICK_CHANNEL_LEASE_BLOCKS = 12960; // ~3 months (Megalith's max lease); clamped LSP-side
  let quickChannelPollToken = 0;
  let quickChannelBusy = false;

  function pollQuickChannel(apiUrl: string, orderId: string): void {
    const token = ++quickChannelPollToken;
    const deadline = Date.now() + 15 * 60 * 1000;
    const tick = async () => {
      if (token !== quickChannelPollToken) return;
      try {
        const order = (await controller.getLSPS1Order(apiUrl, orderId)) as Lsps1RestOrderResponse;
        if (token !== quickChannelPollToken) return;
        const status = lsps1OrderStatus(order);
        if (status === "completed") {
          setMsg("quick-channel-msg", "🎉 Channel open! You can now receive payments.", "ok");
          show($("quick-channel-qr"), false);
          show($("quick-channel-invoice"), false);
          show($("quick-channel-copy"), false);
          void refresh();
          return;
        }
        if (status === "failed") {
          setMsg("quick-channel-msg", "Order failed — the LSP could not open the channel. No sats were kept.", "err");
          return;
        }
        if (status === "paid") {
          setMsg("quick-channel-msg", "✓ Payment received — opening your channel…", "ok");
          show($("quick-channel-qr"), false);
          void refresh();
        }
      } catch {
        /* transient — keep polling */
      }
      if (token === quickChannelPollToken && Date.now() < deadline) setTimeout(() => void tick(), 4000);
    };
    setTimeout(() => void tick(), 4000);
  }

  async function orderQuickChannel(): Promise<void> {
    if (quickChannelBusy) return;
    // MANDATORY cloud backup: never let funds land in a channel before there's an off-device backup
    // destination. The checklist disables this action until Drive is configured, but guard here too
    // (belt-and-suspenders) and point the user at the connect step.
    if (!driveConfigured()) {
      show($("quick-channel"), true);
      $("quick-channel-fee").textContent = "";
      show($("quick-channel-qr"), false);
      show($("quick-channel-invoice"), false);
      show($("quick-channel-copy"), false);
      setMsg("quick-channel-msg", "Turn on cloud backup (Google Drive) first — a channel can't be recovered without a backup.", "err");
      return;
    }
    const provider = quickChannelProvider(LSPS1_PROVIDERS);
    quickChannelBusy = true;
    show($("quick-channel"), true);
    show($("quick-channel-qr"), false);
    show($("quick-channel-invoice"), false);
    show($("quick-channel-copy"), false);
    $("quick-channel-fee").textContent = "";
    setMsg("quick-channel-msg", `Getting a quote from ${provider.name}…`);
    // Bring the pay card into view — the checklist button that triggered this may be above the fold.
    requestAnimationFrame(() => $("quick-channel").scrollIntoView({ behavior: "smooth", block: "center" }));
    try {
      const order = await controller.purchaseLSPS1Capacity({
        amountSats: QUICK_CHANNEL_SATS,
        apiUrl: provider.restBaseUrl,
        providerName: provider.name,
        channelExpiryBlocks: QUICK_CHANNEL_LEASE_BLOCKS,
      });
      $("quick-channel-fee").textContent =
        `A ${QUICK_CHANNEL_SATS.toLocaleString()}-sat channel from ${provider.name} (~3 months). ` +
        `${formatOpeningFee(order.feeTotalSat, QUICK_CHANNEL_SATS)} — scan or pay the invoice to open it.`;
      const inv = $<HTMLTextAreaElement>("quick-channel-invoice");
      inv.value = order.invoice;
      show(inv, true);
      show($("quick-channel-copy"), true);
      try {
        const qr = $<HTMLImageElement>("quick-channel-qr");
        qr.src = await QRCode.toDataURL(order.invoice, { width: 220, margin: 1 });
        show(qr, true);
      } catch (qrErr) {
        console.warn("[QuickChannel] could not render QR:", (qrErr as Error)?.message || qrErr);
      }
      setMsg("quick-channel-msg", "Order placed — pay the invoice to open your channel.", "ok");
      pollQuickChannel(provider.restBaseUrl, order.orderId);
    } catch (e) {
      setMsg("quick-channel-msg", (e as Error).message, "err");
    } finally {
      quickChannelBusy = false;
    }
  }
  $("quick-channel-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($<HTMLTextAreaElement>("quick-channel-invoice").value).catch(() => {});
    setMsg("quick-channel-msg", "Invoice copied", "ok");
  });

  // ---- mandatory cloud backup (checklist step) ----
  // Connects Google Drive (interactive — fine, this runs from a button gesture) and, if the node is
  // running, does an immediate catch-up backup so current state is saved right away. Ongoing state
  // changes are then auto-synced by the listener in main.ts.
  async function connectCloudBackup(): Promise<void> {
    setMsg("checklist-msg", "Connecting Google Drive…");
    try {
      await ensureDriveConnected();
      setMsg("checklist-msg", "Cloud backup on ✓", "ok");
      if (running) {
        void driveBackupNow(controller).catch((e) => console.warn("[DriveSync] initial backup failed:", (e as Error)?.message || e));
      }
      void refresh();
    } catch (e) {
      setMsg("checklist-msg", `Couldn't connect Google Drive: ${(e as Error).message}`, "err");
    }
  }

  onControllerEvent(() => void refresh());
  void refresh();
  // Peer connects/drops emit no wallet events (only channel-state persists do) — poll while open.
  setInterval(() => void refresh(), 5000);
}
