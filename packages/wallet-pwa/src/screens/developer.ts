import type { AppContext } from "../core/app-context";
import { defaultBridgeUrl, defaultRapidGossipSyncUrl } from "../core/wallet-config";
import { googleClientId, setGoogleClientId } from "../drive-integration";
import { enablePush, disablePush, isPushEnabled, pushSupported } from "../web-push";
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

  registerScreen("screen-dev", { onShow: () => void load() });
}
