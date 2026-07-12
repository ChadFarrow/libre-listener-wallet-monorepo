import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initScreens } from "./index";
import { showScreen } from "../ui/nav";
import type { AppContext } from "../core/app-context";
import type { WalletController } from "../wallet-controller";
import { NodeAlreadyRunningError } from "@libre/listener-wallet";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMarkup(): void {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
  document.body.innerHTML = body;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("start() single-node-lock conflict", () => {
  beforeEach(() => {
    loadMarkup();
    localStorage.clear();
  });

  it("shows an 'already running in another tab' message without leaking the code", async () => {
    const controller = {
      getState: vi.fn().mockResolvedValue({
        network: "mainnet",
        running: false,
        hasSeed: true,
        hasChannelState: true,
        createdNew: false,
      }),
      startNode: vi.fn().mockRejectedValue(new NodeAlreadyRunningError()),
      getPayments: vi.fn().mockResolvedValue([]),
    } as unknown as WalletController;
    const ctx: AppContext = { controller, isRunning: () => false, keepAlive: { start() {}, stop() {}, unlock() {}, isActive: () => false, needsActivation: () => false } };

    initScreens(ctx);
    await flush();
    await flush();

    showScreen("screen-node");
    document.getElementById("node-toggle")!.dispatchEvent(new Event("click"));
    await flush();
    await flush();

    expect(controller.startNode).toHaveBeenCalled();
    expect(document.getElementById("node-msg")!.textContent).toMatch(/already running in another tab/i);
    expect(document.getElementById("node-msg")!.textContent).not.toMatch(/NODE_ALREADY_RUNNING/);
  });
});
