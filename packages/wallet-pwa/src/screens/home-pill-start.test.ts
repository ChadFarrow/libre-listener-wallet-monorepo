import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initScreens } from "./index";
import { showScreen } from "../ui/nav";
import type { AppContext } from "../core/app-context";
import type { WalletController } from "../wallet-controller";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the REAL markup so the test wires against the actual ids the screens use.
function loadMarkup(): void {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
  document.body.innerHTML = body;
}

// Mirrors the SDK's ChannelStateRegressionError shape (message prefix + .code) — the same
// discriminator @libre/shared's isChannelStateRegressionError checks.
class RegressionError extends Error {
  code = "CHANNEL_STATE_REGRESSION";
  constructor() {
    super("[CHANNEL_STATE_REGRESSION] channel state regressed below its durable high-water mark");
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isCurrent(screenId: string): boolean {
  return document.getElementById(screenId)!.classList.contains("current");
}

const keepAlive = { start() {}, stop() {}, unlock() {}, isActive: () => false, needsActivation: () => false };

describe("home status pill: tap-to-start starts the node directly (no detour to the Node screen)", () => {
  beforeEach(() => {
    loadMarkup();
    localStorage.clear();
    // Home's refresh() reads a USD rate; jsdom has no fetch, so give it a benign one (the fiat
    // line is best-effort and irrelevant to this test — a missing fetch would abort refresh).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in test")));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tapping the stopped pill calls startNode instead of navigating to screen-node", async () => {
    const controller = {
      getState: vi.fn().mockResolvedValue({
        network: "mainnet",
        running: false,
        hasSeed: true,
        hasChannelState: true,
        createdNew: false,
        channels: 1,
        usableChannels: 1,
        balance: { spendableSat: 1000, receivableSat: 0 },
      }),
      startNode: vi.fn().mockResolvedValue({ nodeId: "abc", network: "mainnet" }),
      getPayments: vi.fn().mockResolvedValue([]),
      isRunning: () => false,
    } as unknown as WalletController;
    const ctx: AppContext = { controller, isRunning: () => false, keepAlive };

    initScreens(ctx);
    showScreen("screen-home");
    await flush();
    await flush();

    // Sanity: the stopped pill is showing tap-to-start.
    expect(document.getElementById("status-pill-text")!.textContent).toMatch(/tap to start/i);

    document.getElementById("status-pill")!.dispatchEvent(new Event("click"));
    await flush();
    await flush();

    expect(controller.startNode).toHaveBeenCalled();
    // It must NOT have bounced the user over to the Node screen — the whole point of the change.
    expect(isCurrent("screen-node")).toBe(false);
    expect(isCurrent("screen-home")).toBe(true);
  });

  it("routes a channel-state regression from the pill to the forced-restore screen", async () => {
    const controller = {
      getState: vi.fn().mockResolvedValue({
        network: "mainnet",
        running: false,
        hasSeed: true,
        hasChannelState: true,
        createdNew: false,
        channels: 1,
        usableChannels: 1,
        balance: { spendableSat: 1000, receivableSat: 0 },
      }),
      startNode: vi.fn().mockRejectedValue(new RegressionError()),
      getPayments: vi.fn().mockResolvedValue([]),
      isRunning: () => false,
    } as unknown as WalletController;
    const ctx: AppContext = { controller, isRunning: () => false, keepAlive };

    initScreens(ctx);
    showScreen("screen-home");
    await flush();
    await flush();

    document.getElementById("status-pill")!.dispatchEvent(new Event("click"));
    await flush();
    await flush();

    expect(controller.startNode).toHaveBeenCalled();
    expect(isCurrent("screen-restore")).toBe(true);
    // The raw SDK error code must never leak into user-facing text (pill or restore message).
    expect(document.getElementById("restore-msg")!.textContent).toMatch(/force-close/i);
    expect(document.getElementById("status-pill-text")!.textContent).not.toMatch(/CHANNEL_STATE_REGRESSION/);
  });
});
