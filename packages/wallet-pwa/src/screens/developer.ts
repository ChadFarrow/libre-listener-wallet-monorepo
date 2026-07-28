import type { AppContext } from "../core/app-context";
import { defaultBridgeUrl, defaultRapidGossipSyncUrl } from "@libre/wallet-core";
import { googleClientId, setGoogleClientId } from "../drive-integration";
import { enablePush, disablePush, isPushEnabled, pushSupported } from "../web-push";
import { keepAliveEnabled, setKeepAliveEnabled } from "../core/keep-alive";
import { diagExportText, diagStats, diagClear } from "../core/diag-tap";
import { nativeShareAvailable, nativeShareText } from "../core/native-share";
import { registerScreen } from "../ui/nav";
import { $, setMsg, copyText } from "./util";

export function initDeveloperScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  const val = (id: string) => $<HTMLInputElement>(id).value.trim();

  async function load(): Promise<void> {
    try {
      const c = await controller.getConfig();
      const network = c.network || "mainnet";
      $<HTMLSelectElement>("network").value = network;
      $<HTMLInputElement>("esplora").value = c.esploraUrl || "";
      $<HTMLInputElement>("bridge").value = c.bridgeUrl || defaultBridgeUrl(network) || "";
      $<HTMLInputElement>("rgs").value = c.rapidGossipSyncUrl || defaultRapidGossipSyncUrl(network) || "";
      setMsg("config-msg", "");
    } catch (e) {
      setMsg("config-msg", (e as Error).message, "err");
    }
    $<HTMLInputElement>("google-client-id").value = googleClientId();
    void refreshPushState();
  }

  $("save-config").addEventListener("click", () => {
    void (async () => {
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
    })();
  });

  $("save-drive").addEventListener("click", () => {
    setGoogleClientId(val("google-client-id"));
    setMsg("drive-msg", "Saved. Reconnect Drive from the Cloud backup screen.", "ok");
  });

  // ---- Web Push (offline wake) ----
  async function refreshPushState(): Promise<void> {
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

  $("push-enable").addEventListener("click", () => {
    void (async () => {
      setMsg("push-msg", "Enabling offline wake…");
      try {
        await enablePush(ctx, val("push-gateway-url"), val("push-relay-url"));
        setMsg("push-msg", "Offline wake enabled. On iOS, install to the home screen for this to fire.", "ok");
        void refreshPushState();
      } catch (e) {
        setMsg("push-msg", (e as Error).message, "err");
      }
    })();
  });
  $("push-disable").addEventListener("click", () => {
    void (async () => {
      try {
        await disablePush(ctx, val("push-gateway-url"), val("push-relay-url"));
        setMsg("push-msg", "Offline wake disabled.", "ok");
        void refreshPushState();
      } catch (e) {
        setMsg("push-msg", (e as Error).message, "err");
      }
    })();
  });

  // ---- Background keep-alive (silent audio) ----
  // The change event is a user gesture, so starting the audio here satisfies the autoplay policy.
  $("keepalive-toggle").addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    setKeepAliveEnabled(on);
    if (on && ctx.isRunning()) {
      ctx.keepAlive.start();
      setMsg("keepalive-msg", "Keeping the node alive in the background. Uses more battery; best-effort on iOS/Android.", "ok");
    } else {
      ctx.keepAlive.stop();
      setMsg("keepalive-msg", on ? "On — starts when the node is running." : "Off.", on ? "ok" : "");
    }
  });

  // ---- Diagnostics (local rolling log; spec 2026-07-11-diag-log-design.md) ----
  async function refreshDiagStats(): Promise<void> {
    try {
      const s = await diagStats();
      $("diag-stats").textContent = s.count === 0 ? "0 entries" : `${s.count} entries · ~${Math.max(1, Math.round(s.bytes / 1024))} KB`;
    } catch {
      $("diag-stats").textContent = "";
    }
  }

  async function diagName(): Promise<string> {
    const { network } = await controller.getState();
    const iso = new Date().toISOString();
    const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
    return `libre-diag-${network || "mainnet"}-${stamp}.txt`;
  }

  $("diag-copy").addEventListener("click", () => {
    void (async () => {
      const text = await diagExportText();
      if (!text) {
        setMsg("diag-msg", "Nothing recorded yet.");
        return;
      }
      const ok = await copyText(text);
      setMsg(
        "diag-msg",
        ok ? "Copied to clipboard." : "Copy failed — try Share instead.",
        ok ? "ok" : "err",
      );
    })();
  });

  $("diag-export").addEventListener("click", () => {
    void (async () => {
      try {
        const text = await diagExportText();
        if (!text) {
          setMsg("diag-msg", "Nothing recorded yet.");
          return;
        }
        const name = await diagName();
        // Native (Android/iOS APK): the OS share sheet. The Android System WebView implements
        // neither navigator.share nor blob downloads, so the web branch below produces NO file there.
        if (nativeShareAvailable()) {
          await nativeShareText(name, text);
          setMsg("diag-msg", "Shared.", "ok");
          return;
        }
        const file = new File([text], name, { type: "text/plain" });
        const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
        if (nav.share && nav.canShare?.({ files: [file] })) {
          await nav.share({ files: [file], title: name });
          setMsg("diag-msg", "Shared.", "ok");
        } else {
          const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          setMsg("diag-msg", `Downloaded ${name}.`, "ok");
        }
      } catch (e) {
        // A cancelled share is the user changing their mind, not an error: the web share sheet throws
        // a DOM AbortError; Capacitor's Share throws an Error whose message contains "cancel".
        const err = e as Error;
        if (err?.name === "AbortError" || /cancel/i.test(err?.message || "")) return;
        setMsg("diag-msg", err.message, "err");
      }
    })();
  });

  $("diag-clear").addEventListener("click", () => {
    void (async () => {
      await diagClear();
      await refreshDiagStats();
      setMsg("diag-msg", "Diagnostics cleared.", "ok");
    })();
  });

  // ---- Force-close (recovery) ----
  // Unilateral and irreversible, so it lives here rather than on the Channels screen. The
  // typed confirmation is deliberate friction: a mis-tap must not be able to end a channel.
  const FORCE_CLOSE_PHRASE = "FORCE CLOSE";

  async function refreshForceCloseList(): Promise<void> {
    const sel = $<HTMLSelectElement>("fc-channel");
    sel.replaceChildren();
    try {
      const channels = await controller.getChannels();
      if (channels.length === 0) {
        sel.append(new Option("No channels", ""));
        return;
      }
      for (const c of channels) {
        const peer = `${c.counterpartyNodeId.slice(0, 10)}…${c.counterpartyNodeId.slice(-6)}`;
        const state = c.isUsable ? "active" : c.isChannelReady ? "peer offline" : "pending";
        const label = `${c.capacitySat.toLocaleString()} sats · ${peer} · ${state}`;
        const opt = new Option(label, c.channelId);
        // Carry the peer we DISPLAYED, so the SDK can refuse a stale row rather than
        // close whatever now sits at this index.
        opt.dataset.peer = c.counterpartyNodeId;
        sel.append(opt);
      }
    } catch (e) {
      sel.append(new Option("Start the node to list channels", ""));
      setMsg("fc-msg", (e as Error).message, "err");
    }
  }

  $("fc-refresh").addEventListener("click", () => {
    void (async () => {
      await refreshForceCloseList();
      setMsg("fc-msg", "");
    })();
  });

  $("fc-go").addEventListener("click", () => {
    void (async () => {
      const sel = $<HTMLSelectElement>("fc-channel");
      const opt = sel.selectedOptions[0];
      const channelId = sel.value;
      if (!channelId) {
        setMsg("fc-msg", "Pick a channel first.", "err");
        return;
      }
      const typed = $<HTMLInputElement>("fc-confirm").value.trim().toUpperCase();
      if (typed !== FORCE_CLOSE_PHRASE) {
        setMsg("fc-msg", `Type ${FORCE_CLOSE_PHRASE} to confirm.`, "err");
        return;
      }
      setMsg("fc-msg", "Force-closing…");
      const res = await controller.forceCloseChannel(channelId, opt?.dataset.peer);
      if (!res.ok) {
        setMsg("fc-msg", res.error, "err");
        return;
      }
      $<HTMLInputElement>("fc-confirm").value = "";
      await refreshForceCloseList();
      setMsg(
        "fc-msg",
        "Closing. The commitment is broadcast; funds return on-chain after the channel delay, then sweep to your recovery address.",
        "ok",
      );
    })();
  });

  registerScreen("screen-dev", {
    onShow: () => {
      void load();
      void refreshForceCloseList();
      $<HTMLInputElement>("fc-confirm").value = "";
      setMsg("fc-msg", "");
      $<HTMLInputElement>("keepalive-toggle").checked = keepAliveEnabled();
      // If keep-alive is enabled + running but iOS hasn't let the audio start (no tap yet), tell
      // the user a single tap activates it — otherwise "enabled" reads as "working" when it isn't.
      if (keepAliveEnabled() && ctx.keepAlive.needsActivation()) {
        setMsg("keepalive-msg", "Enabled — tap the screen once to activate background audio (iOS needs a tap).", "err");
      }
      void refreshDiagStats();
    },
  });
}
