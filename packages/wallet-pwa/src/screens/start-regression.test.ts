import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initScreens } from "./index";
import { showScreen } from "../ui/nav";
import { emitControllerEvent } from "../core/events";
import type { AppContext } from "../core/app-context";
import type { WalletControllerApi } from "@libre/wallet-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the REAL markup (not a hand-rolled stub) so the test exercises the actual ids/structure
// the screens wire against, rather than a fixture that could drift from index.html.
function loadMarkup(): void {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
  document.body.innerHTML = body;
}

// Mirrors the SDK's ChannelStateRegressionError shape (message prefix + .code) without importing
// the SDK — same discriminator @libre/shared's isChannelStateRegressionError checks.
class RegressionError extends Error {
  code = "CHANNEL_STATE_REGRESSION";
  constructor() {
    super("[CHANNEL_STATE_REGRESSION] channel state regressed below its durable high-water mark");
  }
}

// Mirrors the app's BackupAheadError shape (message token + .code) — the discriminator
// core/backup-ahead's isBackupAheadError checks.
class BackupAheadStub extends Error {
  code = "BACKUP_AHEAD";
  constructor() {
    super("cloud backup newer than local [BACKUP_AHEAD]");
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function isCurrent(screenId: string): boolean {
  return document.getElementById(screenId)!.classList.contains("current");
}

describe("start() channel-state regression → forced restore screen", () => {
  beforeEach(() => {
    loadMarkup();
    localStorage.clear();
  });

  it("lands on the restore screen with a clear message, and the latch survives refreshes", async () => {
    const controller = {
      // A funded wallet exists (the scenario a regression fires in) — a naive refresh would
      // route this state straight to home.
      getState: vi.fn().mockResolvedValue({
        network: "mainnet",
        running: false,
        hasSeed: true,
        hasChannelState: true,
        createdNew: false,
      }),
      startNode: vi.fn().mockRejectedValue(new RegressionError()),
      getPayments: vi.fn().mockResolvedValue([]),
    } as unknown as WalletControllerApi;
    const ctx: AppContext = { controller, isRunning: () => false, keepAlive: { start() {}, stop() {}, unlock() {}, isActive: () => false, needsActivation: () => false } };

    initScreens(ctx);
    await flush();
    await flush();

    showScreen("screen-node");
    document.getElementById("node-toggle")!.dispatchEvent(new Event("click"));
    await flush();
    await flush();

    expect(controller.startNode).toHaveBeenCalled();
    expect(isCurrent("screen-restore")).toBe(true);
    expect(document.getElementById("restore-msg")!.textContent).toMatch(/force-close/i);
    // The raw SDK error code must never leak into user-facing text.
    expect(document.getElementById("restore-msg")!.textContent).not.toMatch(/CHANNEL_STATE_REGRESSION/);
    expect(document.getElementById("node-msg")!.textContent).not.toMatch(/CHANNEL_STATE_REGRESSION/);

    // Prove the latch: a state-changed refresh (the same path the controller's events drive in
    // the real app) must not route away from the restore screen just because a wallet exists.
    emitControllerEvent("state-changed");
    await flush();
    await flush();
    expect(isCurrent("screen-restore")).toBe(true);
  });

  it("routes a backup-ahead start error to the restore screen without leaking the code", async () => {
    const controller = {
      getState: vi.fn().mockResolvedValue({
        network: "mainnet",
        running: false,
        hasSeed: true,
        hasChannelState: true,
        createdNew: false,
      }),
      startNode: vi.fn().mockRejectedValue(new BackupAheadStub()),
      getPayments: vi.fn().mockResolvedValue([]),
    } as unknown as WalletControllerApi;
    const ctx: AppContext = { controller, isRunning: () => false, keepAlive: { start() {}, stop() {}, unlock() {}, isActive: () => false, needsActivation: () => false } };

    initScreens(ctx);
    await flush();
    await flush();

    showScreen("screen-node");
    document.getElementById("node-toggle")!.dispatchEvent(new Event("click"));
    await flush();
    await flush();

    expect(controller.startNode).toHaveBeenCalled();
    expect(isCurrent("screen-restore")).toBe(true);
    const msg = document.getElementById("restore-msg")!.textContent || "";
    expect(msg).toMatch(/backup/i);
    expect(msg).toMatch(/force-close/i);
    expect(msg).not.toMatch(/BACKUP_AHEAD/); // raw code never leaks to the UI
    expect(document.getElementById("node-msg")!.textContent).not.toMatch(/BACKUP_AHEAD/);
  });
});
