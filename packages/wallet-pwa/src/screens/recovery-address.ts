import type { AppContext } from "../core/app-context";
import { registerScreen } from "../ui/nav";
import { $, setMsg } from "./util";

export function initRecoveryAddressScreen(ctx: AppContext): void {
  const controller = ctx.controller;

  async function load(): Promise<void> {
    const r = await controller.getSweepAddress().catch(() => ({ address: "" }));
    $<HTMLInputElement>("sweep-address").value = r.address || "";
    setMsg("sweep-msg", "");
  }

  $("save-sweep").addEventListener("click", () => {
    void (async () => {
      try {
        const r = await controller.setSweepAddress($<HTMLInputElement>("sweep-address").value.trim());
        setMsg("sweep-msg", r.address ? "Sweep address saved." : "Sweep address cleared.", "ok");
      } catch (e) {
        setMsg("sweep-msg", (e as Error).message, "err");
      }
    })();
  });

  registerScreen("screen-sweep", { onShow: () => void load() });
}
