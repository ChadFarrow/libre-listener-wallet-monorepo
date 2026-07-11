import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initScreens } from "./index";
import { openDrawer } from "../ui/nav";
import type { AppContext } from "../core/app-context";
import type { WalletController } from "../wallet-controller";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMarkup(): void {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
  document.body.innerHTML = body;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Regression: tapping a drawer item must open its screen. The old path closed the drawer via
// history.back() (an async popstate) and then synchronously pushState-ed the screen — the late
// popstate popped the just-pushed screen right back, so the drawer closed but nothing opened
// (seen on iOS). showScreenFromDrawer shares the drawer's history entry instead.
describe("drawer → screen navigation", () => {
  beforeEach(() => {
    loadMarkup();
    localStorage.clear();
  });

  it("opens the tapped screen and keeps it open after any async popstate", async () => {
    const controller = {
      getState: vi.fn().mockResolvedValue({
        network: "mainnet",
        running: true,
        hasSeed: true,
        hasChannelState: true,
        createdNew: false,
        channels: 1,
        usableChannels: 0,
        peers: 1,
      }),
      getPayments: vi.fn().mockResolvedValue([]),
      listPeers: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue({ spendableSat: 0, receivableSat: 0 }),
      getChannels: vi.fn().mockResolvedValue([]),
    } as unknown as WalletController;
    const ctx: AppContext = { controller, isRunning: () => true, keepAlive: { start() {}, stop() {}, isActive: () => false } };

    initScreens(ctx);
    await flush();

    openDrawer();
    document.getElementById("d-node")!.dispatchEvent(new Event("click"));
    await flush();
    await flush(); // let any queued popstate settle

    const node = document.getElementById("screen-node")!;
    const drawer = document.getElementById("drawer")!;
    expect(node.classList.contains("current")).toBe(true);
    expect(drawer.classList.contains("open")).toBe(false);
  });
});
