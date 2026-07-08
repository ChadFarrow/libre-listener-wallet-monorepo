import QRCode from "qrcode";
import type { AppContext } from "../core/app-context";
import { emitControllerEvent, onControllerEvent } from "../core/events";
import { setSeedBackedUp } from "../core/onboarding";
import { confirmModal } from "../ui/confirm-modal";
import { defaultBridgeUrl, defaultRapidGossipSyncUrl, parsePeerString } from "../core/wallet-config";
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
import {
  googleClientId,
  setGoogleClientId,
  driveConnected,
  rememberedEmail,
  ensureDriveConnected,
  driveBackupNow,
} from "../drive-integration";
import { enablePush, disablePush, isPushEnabled, pushSupported } from "../web-push";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => $<HTMLInputElement>(id).value.trim();
const setMsg = (id: string, text: string, kind: "" | "ok" | "err" = "") => {
  const m = $(id);
  m.textContent = text;
  m.className = `msg ${kind}`;
};

const AUTO_DOWNLOAD_KEY = "libre_auto_download";

export function initSettings(ctx: AppContext): void {
  const controller = ctx.controller;
  let currentNetwork = "mainnet";
  let lsps1Running = false;
  let lsps1Valid = false;

  // ---- connection config ----
  async function loadConfig() {
    try {
      const c = await controller.getConfig();
      currentNetwork = c.network || "mainnet";
      $<HTMLSelectElement>("network").value = currentNetwork;
      $("reset-network").textContent = currentNetwork;
      $<HTMLInputElement>("esplora").value = c.esploraUrl || "";
      $<HTMLInputElement>("bridge").value = c.bridgeUrl || defaultBridgeUrl(currentNetwork) || "";
      $<HTMLInputElement>("rgs").value = c.rapidGossipSyncUrl || defaultRapidGossipSyncUrl(currentNetwork) || "";
    } catch (e) {
      setMsg("config-msg", (e as Error).message, "err");
    }
    $<HTMLInputElement>("google-client-id").value = googleClientId();
  }

  $("save-config").addEventListener("click", async () => {
    try {
      await controller.setConfig({
        network: $<HTMLSelectElement>("network").value as Awaited<ReturnType<typeof controller.getConfig>>["network"],
        esploraUrl: val("esplora"),
        bridgeUrl: val("bridge"),
        rapidGossipSyncUrl: val("rgs"),
      });
      setMsg("config-msg", "Saved", "ok");
    } catch (e) {
      setMsg("config-msg", (e as Error).message, "err");
    }
  });

  $("save-drive").addEventListener("click", () => {
    setGoogleClientId(val("google-client-id"));
    setMsg("drive-msg", "Saved. Now click Connect Drive above.", "ok");
  });

  // ---- sweep address ----
  async function loadSweep() {
    const r = await controller.getSweepAddress().catch((e) => {
      console.warn("[Settings] getSweepAddress failed:", (e as Error)?.message || e);
      return { address: "" };
    });
    $<HTMLInputElement>("sweep-address").value = r.address || "";
  }
  $("save-sweep").addEventListener("click", async () => {
    try {
      const r = await controller.setSweepAddress(val("sweep-address"));
      setMsg("sweep-msg", r.address ? "Sweep address saved." : "Sweep address cleared.", "ok");
    } catch (e) {
      setMsg("sweep-msg", (e as Error).message, "err");
    }
  });

  // ---- LSPS1: buy inbound capacity ----
  function updateLsps1OrderBtn() {
    ($("lsps1-order") as HTMLButtonElement).disabled = !(lsps1Running && lsps1Valid);
  }
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
      msgEl.className = "msg";
    } else {
      const alt = suggestProviderForAmount(amountSats, providerKey);
      msgEl.textContent = `${check.message ?? "Invalid amount."}${alt ? ` Try ${alt.provider.name}, which serves this size.` : ""}`;
      msgEl.className = "msg err";
    }
    lsps1Valid = check.ok;
    updateLsps1OrderBtn();
  }
  $("lsps1-provider").addEventListener("change", refreshLsps1Provider);
  $("lsps1-amount").addEventListener("input", refreshLsps1Provider);

  let lsps1PollToken = 0;
  function hideLsps1Invoice() {
    $("lsps1-invoice").style.display = "none";
    $("lsps1-invoice-label").style.display = "none";
    $("lsps1-invoice-qr").style.display = "none";
  }
  function startLsps1OrderPoll(apiUrl: string, orderId: string) {
    const token = ++lsps1PollToken;
    const deadline = Date.now() + 15 * 60 * 1000;
    const tick = async () => {
      if (token !== lsps1PollToken) return;
      try {
        const order = (await controller.getLSPS1Order(apiUrl, orderId)) as Lsps1RestOrderResponse;
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
          setMsg("lsps1-msg", "✓ Payment received — opening your channel…", "ok");
          void loadChannels();
        }
      } catch {
        /* transient — keep polling */
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
    hideLsps1Invoice();
    setMsg("lsps1-msg", `Getting quote from ${provider.name}…`);
    try {
      const order = await controller.purchaseLSPS1Capacity({
        amountSats,
        apiUrl: provider.restBaseUrl,
        providerName: provider.name,
        ...(channelExpiryBlocks != null ? { channelExpiryBlocks } : {}),
      });
      const fee = $("lsps1-fee-readout");
      fee.textContent = `${provider.name} opening fee: ${formatOpeningFee(order.feeTotalSat, amountSats)} — pay only if you want this channel.`;
      fee.style.display = "block";
      const inv = $<HTMLTextAreaElement>("lsps1-invoice");
      inv.value = order.invoice;
      inv.style.display = "block";
      $("lsps1-invoice-label").style.display = "block";
      try {
        const qr = $<HTMLImageElement>("lsps1-invoice-qr");
        qr.src = await QRCode.toDataURL(order.invoice, { width: 220, margin: 1 });
        qr.style.display = "block";
      } catch (qrErr) {
        console.warn("[LSPS1] could not render invoice QR:", (qrErr as Error)?.message || qrErr);
      }
      setMsg("lsps1-msg", `Order ${order.orderId} placed. Pay the invoice below to open the channel.`, "ok");
      startLsps1OrderPoll(provider.restBaseUrl, order.orderId);
    } catch (e) {
      setMsg("lsps1-msg", (e as Error).message, "err");
    } finally {
      btn.disabled = false;
      updateLsps1OrderBtn();
    }
  });

  // ---- connect peer ----
  $("connect-peer").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("connect-peer");
    if (btn.disabled) return;
    let peer;
    try {
      peer = parsePeerString(val("peer-conn"));
    } catch (e) {
      setMsg("peer-msg", (e as Error).message, "err");
      return;
    }
    // Disable during the dial so a double-tap can't fire duplicate connectPeer calls; re-enable in finally.
    btn.disabled = true;
    try {
      await controller.connectPeer(peer.pubkey, peer.host, peer.port);
      setMsg("peer-msg", "Peer connected", "ok");
    } catch (e) {
      setMsg("peer-msg", (e as Error).message, "err");
    } finally {
      btn.disabled = false;
    }
  });

  // ---- node id ----
  async function loadNodeInfo() {
    const s = await controller.getState().catch(() => ({}) as { nodeId?: string });
    $<HTMLInputElement>("node-id").value = s.nodeId || "";
  }
  $("copy-node-id").addEventListener("click", async () => {
    const id = val("node-id");
    if (!id) {
      setMsg("node-id-msg", "Start the node to load your Node ID.", "err");
      return;
    }
    try {
      await navigator.clipboard.writeText(id);
      setMsg("node-id-msg", "Node ID copied", "ok");
    } catch {
      setMsg("node-id-msg", "Copy failed — select the field and copy manually.", "err");
    }
  });

  // ---- backup: export + auto-download + Drive ----
  // Any real backup action (view/copy the phrase, export a file, connect/sync Drive) satisfies the
  // Home onboarding checklist's "Back up your recovery phrase" step. Emit so Home re-renders it.
  async function markSeedBackedUp(): Promise<void> {
    try {
      const { network } = await controller.getState();
      if (network) {
        setSeedBackedUp(network);
        emitControllerEvent("state-changed");
      }
    } catch {
      // best-effort — the checklist just stays visible if we can't read the network.
    }
  }
  async function refreshBackupState() {
    const running = ctx.isRunning();
    ($("export") as HTMLButtonElement).disabled = !running;
    ($("drive-backup-now") as HTMLButtonElement).disabled = !running;
    if (!running) setMsg("backup-msg", "Start the node to export or sync a backup.");
    lsps1Running = running;
    updateLsps1OrderBtn();
  }

  $("export").addEventListener("click", async () => {
    setMsg("backup-msg", "Preparing backup…");
    try {
      const env = await controller.exportBackup();
      const { network } = await controller.getState();
      const name = downloadBackupName(network || "mainnet", env, new Date());
      const url = URL.createObjectURL(new Blob([env], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setMsg("backup-msg", `Downloaded ${name}. Store it safely.`, "ok");
      void markSeedBackedUp();
    } catch (e) {
      setMsg("backup-msg", (e as Error).message, "err");
    }
  });

  ($("auto-download") as HTMLInputElement).checked = localStorage.getItem(AUTO_DOWNLOAD_KEY) === "1";
  $("auto-download").addEventListener("change", (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    localStorage.setItem(AUTO_DOWNLOAD_KEY, enabled ? "1" : "0");
    setMsg(
      "backup-msg",
      enabled ? "Auto-backup on. A dated file downloads when your wallet changes." : "Auto-backup off.",
      "ok"
    );
  });

  function refreshDriveStatus() {
    const connected = driveConnected();
    const email = rememberedEmail();
    $("drive-status").textContent = connected
      ? `Google Drive: connected${email ? ` (${email})` : ""} — ready to sync`
      : email
        ? `Google Drive: reconnect ${email}`
        : "Google Drive: not connected";
    ($("drive-connect") as HTMLButtonElement).textContent = connected ? "Reconnect" : "Connect Drive";
  }
  $("drive-connect").addEventListener("click", async () => {
    setMsg("backup-msg", "Opening Google sign-in…");
    try {
      await ensureDriveConnected();
      setMsg("backup-msg", "Drive connected", "ok");
      refreshDriveStatus();
      void markSeedBackedUp();
    } catch (e) {
      setMsg("backup-msg", (e as Error).message, "err");
    }
  });
  $("drive-backup-now").addEventListener("click", async () => {
    setMsg("backup-msg", "Backing up to Drive…");
    try {
      const { network } = await driveBackupNow(controller);
      setMsg("backup-msg", `Backed up (${network}) to Google Drive`, "ok");
      void markSeedBackedUp();
    } catch (e) {
      setMsg("backup-msg", (e as Error).message, "err");
    }
  });

  // ---- reveal recovery phrase + hex seed (blurred) ----
  // The secrets are derived on demand and written into the DOM ONLY when the user
  // clicks Unhide — never at init or on state-changed. A CSS blur is not real
  // protection: leaving the seed in a live textarea all session is an exposure, so
  // we clear the fields on Hide and whenever the user navigates away.
  // Grow a readonly textarea to fit its content so the full 24-word phrase is
  // visible without scrolling inside the box (it wraps to more lines on a narrow
  // mobile screen than the fixed `rows` allows).
  function autoSize(el: HTMLTextAreaElement): void {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }
  async function revealPhrase(): Promise<boolean> {
    const phraseBox = $<HTMLTextAreaElement>("phrase-words");
    const hexBox = $<HTMLTextAreaElement>("seed-hex");
    try {
      const [{ mnemonic }, { seedHex }] = await Promise.all([controller.getRecoveryPhrase(), controller.getSeed()]);
      phraseBox.value = mnemonic;
      hexBox.value = seedHex;
      autoSize(phraseBox);
      autoSize(hexBox);
      return true;
    } catch (e) {
      phraseBox.value = "";
      hexBox.value = "";
      setMsg("phrase-msg", (e as Error)?.message || "No recovery phrase yet — create or restore a wallet first.");
      return false;
    }
  }
  function clearPhraseFields(): void {
    for (const id of ["phrase-words", "seed-hex"]) {
      const el = $<HTMLTextAreaElement>(id);
      el.value = "";
      el.style.height = ""; // collapse back to the CSS `rows` height
      el.classList.add("phrase-blur");
    }
    $("toggle-phrase-blur").textContent = "Unhide";
  }
  $("toggle-phrase-blur").addEventListener("click", () => {
    void (async () => {
      const isBlurred = $<HTMLTextAreaElement>("phrase-words").classList.contains("phrase-blur");
      if (isBlurred) {
        // Reveal: derive + populate now, then un-blur only if we actually have a seed.
        if (!(await revealPhrase())) return;
        $<HTMLTextAreaElement>("phrase-words").classList.remove("phrase-blur");
        $<HTMLTextAreaElement>("seed-hex").classList.remove("phrase-blur");
        $("toggle-phrase-blur").textContent = "Hide";
        setMsg("phrase-msg", "Write these down in order and keep them offline.", "ok");
        void markSeedBackedUp();
      } else {
        // Hide: re-blur AND wipe the secrets out of the DOM.
        clearPhraseFields();
      }
    })();
  });
  // Wipe secrets from the DOM when the user leaves the Settings tab.
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".tab"))) {
    el.addEventListener("click", () => {
      if (el.dataset.tab !== "settings") clearPhraseFields();
    });
  }
  async function copyField(id: string, label: string) {
    const value = $<HTMLTextAreaElement>(id).value.trim();
    if (!value) {
      setMsg("phrase-msg", `No ${label} to copy.`, "err");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setMsg("phrase-msg", `${label} copied to clipboard.`, "ok");
      void markSeedBackedUp();
    } catch {
      setMsg("phrase-msg", "Copy failed.", "err");
    }
  }
  $("copy-phrase").addEventListener("click", () => void copyField("phrase-words", "Recovery phrase"));
  $("copy-seed-hex").addEventListener("click", () => void copyField("seed-hex", "Hex seed"));

  // ---- Web Push (offline wake) ----
  async function refreshPushState() {
    const supported = await pushSupported();
    ($("push-enable") as HTMLButtonElement).disabled = !supported;
    if (!supported) {
      setMsg("push-msg", "Push notifications aren't supported in this browser.");
      return;
    }
    const on = await isPushEnabled().catch(() => false);
    ($("push-disable") as HTMLButtonElement).disabled = !on;
    if (on) setMsg("push-msg", "Offline wake enabled.", "ok");
  }
  $("push-enable").addEventListener("click", async () => {
    setMsg("push-msg", "Enabling offline wake…");
    try {
      await enablePush(ctx, val("push-gateway-url"), val("push-relay-url"));
      setMsg("push-msg", "Offline wake enabled. On iOS, install to the home screen for this to fire.", "ok");
      void refreshPushState();
    } catch (e) {
      setMsg("push-msg", (e as Error).message, "err");
    }
  });
  $("push-disable").addEventListener("click", async () => {
    try {
      await disablePush(ctx, val("push-gateway-url"), val("push-relay-url"));
      setMsg("push-msg", "Offline wake disabled.", "ok");
      void refreshPushState();
    } catch (e) {
      setMsg("push-msg", (e as Error).message, "err");
    }
  });

  // ---- reset wallet ----
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
      const r = await controller.resetWallet();
      setMsg("reset-msg", `Wallet on ${r.network} deleted. Open the Wallet tab to create or restore.`, "ok");
    } catch (e) {
      setMsg("reset-msg", (e as Error).message, "err");
    } finally {
      btn.disabled = false;
    }
  });

  // ---- channels ----
  async function loadChannels() {
    const el = $("channels-list");
    if (!ctx.isRunning()) {
      el.textContent = "Start the node to see your channels.";
      return;
    }
    const chans = await controller.getChannels().catch((e) => {
      console.warn("[Settings] getChannels failed:", (e as Error)?.message || e);
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
          `<div style="padding:8px 0;border-bottom:1px solid var(--border)">` +
          `<div style="word-break:break-all"><b>${c.channelId}</b> <span style="color:${color}">● ${state}</span></div>` +
          `<div class="hint">capacity ${c.capacitySat.toLocaleString()} sat · send ${c.outboundSendableSat.toLocaleString()} / recv ${c.inboundSat.toLocaleString()}${txLink}</div>` +
          `<div class="hint" style="word-break:break-all">peer ${c.counterpartyNodeId}</div>` +
          `</div>`
        );
      })
      .join("");
  }

  // ---- initial load ----
  void loadConfig().then(() => void loadChannels());
  void loadNodeInfo();
  void loadSweep();
  // Recovery phrase + seed are NOT loaded here — only on an explicit Unhide click.
  void refreshBackupState();
  void refreshPushState();
  refreshDriveStatus();
  refreshLsps1Provider();

  onControllerEvent((event) => {
    if (event === "state-changed") {
      void refreshBackupState();
      void loadChannels();
      void loadNodeInfo();
    }
  });
}
