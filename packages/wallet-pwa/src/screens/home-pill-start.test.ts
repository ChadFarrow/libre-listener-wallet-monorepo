import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initScreens } from "./index";
import { showScreen } from "../ui/nav";
import { PILL_SETTLE_MS } from "./home";
import type { AppContext } from "../core/app-context";
import type { WalletControllerApi } from "@libre/wallet-core";

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

function isCurrent(screenId: string): boolean {
  return document.getElementById(screenId)!.classList.contains("current");
}

const keepAlive = { start() {}, stop() {}, unlock() {}, isActive: () => false, needsActivation: () => false };

// Stopped, funded wallet — the state the "Node stopped — tap to start" pill renders for (once the
// boot settle window has passed).
function stoppedState() {
  return {
    network: "mainnet",
    running: false,
    starting: false,
    hasSeed: true,
    hasChannelState: true,
    createdNew: false,
    channels: 1,
    usableChannels: 1,
    balance: { spendableSat: 1000, receivableSat: 0 },
  };
}

describe("home status pill: tap-to-start starts the node directly (no detour to the Node screen)", () => {
  beforeEach(() => {
    loadMarkup();
    localStorage.clear();
    // Home's refresh() reads a USD rate; jsdom has no fetch, so give it a benign one (the fiat
    // line is best-effort and irrelevant to this test — a missing fetch would abort refresh).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in test")));
    // The pill has a post-launch settle window that hides the "stopped" pill during boot; drive the
    // clock past it so the pill renders its real (stopped) state, which is what this test taps.
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tapping the stopped pill calls startNode instead of navigating to screen-node", async () => {
    const controller = {
      getState: vi.fn().mockResolvedValue(stoppedState()),
      startNode: vi.fn().mockResolvedValue({ nodeId: "abc", network: "mainnet" }),
      getPayments: vi.fn().mockResolvedValue([]),
      isRunning: () => false,
    } as unknown as WalletControllerApi;
    const ctx: AppContext = { controller, isRunning: () => false, keepAlive };

    initScreens(ctx);
    showScreen("screen-home");
    // Advance past the settle window (also flushes refresh's pending promises).
    await vi.advanceTimersByTimeAsync(PILL_SETTLE_MS + 500);

    // Now the stopped pill is showing tap-to-start.
    expect(document.getElementById("status-pill-text")!.textContent).toMatch(/tap to start/i);

    document.getElementById("status-pill")!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(200);

    expect(controller.startNode).toHaveBeenCalled();
    // It must NOT have bounced the user over to the Node screen — the whole point of the change.
    expect(isCurrent("screen-node")).toBe(false);
    expect(isCurrent("screen-home")).toBe(true);
  });

  it("routes a channel-state regression from the pill to the forced-restore screen", async () => {
    const controller = {
      getState: vi.fn().mockResolvedValue(stoppedState()),
      startNode: vi.fn().mockRejectedValue(new RegressionError()),
      getPayments: vi.fn().mockResolvedValue([]),
      isRunning: () => false,
    } as unknown as WalletControllerApi;
    const ctx: AppContext = { controller, isRunning: () => false, keepAlive };

    initScreens(ctx);
    showScreen("screen-home");
    await vi.advanceTimersByTimeAsync(PILL_SETTLE_MS + 500);

    document.getElementById("status-pill")!.dispatchEvent(new Event("click"));
    await vi.advanceTimersByTimeAsync(200);

    expect(controller.startNode).toHaveBeenCalled();
    expect(isCurrent("screen-restore")).toBe(true);
    // The raw SDK error code must never leak into user-facing text (pill or restore message).
    expect(document.getElementById("restore-msg")!.textContent).toMatch(/force-close/i);
    expect(document.getElementById("status-pill-text")!.textContent).not.toMatch(/CHANNEL_STATE_REGRESSION/);
  });
});
