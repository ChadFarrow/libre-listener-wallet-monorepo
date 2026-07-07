import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initHome } from "./home";
import { emitControllerEvent } from "../core/events";
import type { AppContext } from "../core/app-context";
import type { WalletController } from "../wallet-controller";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the REAL markup (not a hand-rolled stub) so the test exercises the actual ids/structure
// home.ts wires against, rather than a fixture that could drift from index.html.
function loadHomeMarkup(): void {
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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function hidden(id: string): boolean {
  return document.getElementById(id)!.classList.contains("hidden");
}

describe("home view: start() channel-state regression", () => {
  beforeEach(() => {
    loadHomeMarkup();
    localStorage.clear();
  });

  it("shows the restore panel with a clear message, and the latch survives a later refresh()", async () => {
    const controller = {
      // A funded wallet exists (this is the scenario a regression fires in) — a naive refresh()
      // would hide setup-view/restore-panel for this state.
      getState: vi.fn().mockResolvedValue({
        network: "mainnet",
        running: false,
        hasSeed: true,
        hasChannelState: true,
        createdNew: false,
      }),
      startNode: vi.fn().mockRejectedValue(new RegressionError()),
    } as unknown as WalletController;

    const ctx: AppContext = { controller, isRunning: () => false };

    initHome(ctx);
    await flush();
    await flush();

    // Sanity: before the failed start, the known-funded wallet state hides setup-view.
    expect(hidden("setup-view")).toBe(true);

    document.getElementById("start")!.dispatchEvent(new Event("click"));
    await flush();
    await flush();

    expect(controller.startNode).toHaveBeenCalled();
    expect(hidden("setup-view")).toBe(false);
    expect(hidden("restore-panel")).toBe(false);
    expect(hidden("create-panel")).toBe(true);
    expect(hidden("wallet-view")).toBe(true);
    expect(document.getElementById("restore-msg")!.textContent).toMatch(/force-close/i);
    // The generic error box must NOT show the raw SDK message for this case.
    expect(document.getElementById("msg")!.textContent).not.toMatch(/CHANNEL_STATE_REGRESSION/);

    // Prove the `needsRestore` latch: an independent refresh (the same path the controller's
    // state-changed event drives in the real app) must not re-hide the restore panel just because
    // getState() still reports a wallet exists.
    emitControllerEvent("state-changed");
    await flush();
    await flush();

    expect(hidden("setup-view")).toBe(false);
    expect(hidden("restore-panel")).toBe(false);
  });
});
