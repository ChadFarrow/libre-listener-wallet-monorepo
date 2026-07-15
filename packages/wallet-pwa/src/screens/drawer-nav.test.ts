import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initScreens } from "./index";
import { openDrawer } from "../ui/nav";
import type { AppContext } from "../core/app-context";
import type { WalletControllerApi } from "@libre/wallet-core";

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
    } as unknown as WalletControllerApi;
    const ctx: AppContext = { controller, isRunning: () => true, keepAlive: { start() {}, stop() {}, unlock() {}, isActive: () => false, needsActivation: () => false } };

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

  // On desktop the drawer is a permanent sidebar and each item push()es a screen, so after
  // browsing several settings the ← button needed several clicks to get back. The Wallet item
  // jumps straight home, however deep the stack is.
  it("the Wallet item returns to home in one click after stacking several screens", async () => {
    const controller = {
      getState: vi.fn().mockResolvedValue({
        network: "mainnet",
        running: true,
        hasSeed: true,
        hasChannelState: true,
        createdNew: false,
        channels: 1,
        usableChannels: 1,
        peers: 1,
      }),
      getPayments: vi.fn().mockResolvedValue([]),
      listPeers: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue({ spendableSat: 0, receivableSat: 0 }),
      getChannels: vi.fn().mockResolvedValue([]),
      getConfig: vi.fn().mockResolvedValue({ network: "mainnet" }),
    } as unknown as WalletControllerApi;
    const ctx: AppContext = { controller, isRunning: () => true, keepAlive: { start() {}, stop() {}, unlock() {}, isActive: () => false, needsActivation: () => false } };

    initScreens(ctx);
    await flush();

    // Browse a few settings screens the way the desktop sidebar does.
    openDrawer();
    document.getElementById("d-node")!.dispatchEvent(new Event("click"));
    await flush();
    openDrawer();
    document.getElementById("d-channels")!.dispatchEvent(new Event("click"));
    await flush();
    openDrawer();
    document.getElementById("d-peers")!.dispatchEvent(new Event("click"));
    await flush();

    document.getElementById("d-home")!.dispatchEvent(new Event("click"));
    await flush();
    await flush();

    expect(document.getElementById("screen-home")!.classList.contains("current")).toBe(true);
    expect(document.getElementById("screen-peers")!.classList.contains("current")).toBe(false);
    expect(document.getElementById("drawer")!.classList.contains("open")).toBe(false);
  });
});
