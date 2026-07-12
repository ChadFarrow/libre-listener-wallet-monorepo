import type { AppContext } from "../core/app-context";
import { defaultBridgeUrl, defaultRapidGossipSyncUrl } from "../core/wallet-config";
import { googleClientId, setGoogleClientId } from "../drive-integration";
import { enablePush, disablePush, isPushEnabled, pushSupported } from "../web-push";
import { keepAliveEnabled, setKeepAliveEnabled } from "../core/keep-alive";
import { diagExportText, diagStats, diagClear } from "../core/diag-tap";
import { isNativeApp } from "../core/native-bridge";
import { nativeSaveText } from "../core/native-share";
import { registerScreen } from "../ui/nav";
import { $, setMsg } from "./util";

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

  $("diag-export").addEventListener("click", () => {
    void (async () => {
      try {
        const text = await diagExportText();
        if (!text) {
          setMsg("diag-msg", "Nothing recorded yet.");
          return;
        }
        const { network } = await controller.getState();
        const iso = new Date().toISOString();
        const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
        const name = `libre-diag-${network || "mainnet"}-${stamp}.txt`;
        // Inside the native Android wrapper the browser export paths below don't work — a WebView has
        // no blob download handler and no Web Share file support — so route through the native SAF
        // "Save document" dialog. If that plugin is missing (an APK built before it shipped), fall back
        // to copying the log to the clipboard so export is never a dead button in the wrapper.
        if (isNativeApp()) {
          if (await nativeSaveText(name, text)) {
            setMsg("diag-msg", "Saved.", "ok");
            return;
          }
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            setMsg("diag-msg", "Copied to clipboard — paste into a note or email.", "ok");
            return;
          }
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
        // iOS share sheet cancel throws AbortError — that's the user changing their mind, not an error.
        if ((e as Error)?.name === "AbortError") return;
        setMsg("diag-msg", (e as Error).message, "err");
      }
    })();
  });

  // Copy-to-clipboard: the bulletproof export. Works in every secure context (browser, iOS PWA, and
  // the Android WebView, where file download/share don't) — the user pastes the log into a note or
  // email. No native plugin or download handler needed.
  $("diag-copy").addEventListener("click", () => {
    void (async () => {
      try {
        const text = await diagExportText();
        if (!text) {
          setMsg("diag-msg", "Nothing recorded yet.");
          return;
        }
        if (!navigator.clipboard?.writeText) {
          setMsg("diag-msg", "Clipboard unavailable here — use Export instead.", "err");
          return;
        }
        await navigator.clipboard.writeText(text);
        setMsg("diag-msg", "Copied to clipboard.", "ok");
      } catch (e) {
        setMsg("diag-msg", (e as Error).message, "err");
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

  registerScreen("screen-dev", {
    onShow: () => {
      void load();
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
