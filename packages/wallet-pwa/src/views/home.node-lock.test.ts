import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initHome } from "./home";
import type { AppContext } from "../core/app-context";
import type { WalletController } from "../wallet-controller";
import { NodeAlreadyRunningError } from "@libre/listener-wallet";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load the REAL markup (not a hand-rolled stub) so the test exercises the actual ids/structure
// home.ts wires against, rather than a fixture that could drift from index.html.
function loadHomeMarkup(): void {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
  document.body.innerHTML = body;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("home view: start() single-node-lock conflict", () => {
  beforeEach(() => {
    loadHomeMarkup();
    localStorage.clear();
  });

  it("shows an 'already running in another tab' message when the lock is held elsewhere", async () => {
    const controller = {
      getState: vi.fn().mockResolvedValue({
        network: "mainnet",
        running: false,
        hasSeed: true,
        hasChannelState: true,
        createdNew: false,
      }),
      startNode: vi.fn().mockRejectedValue(new NodeAlreadyRunningError()),
    } as unknown as WalletController;

    const ctx: AppContext = { controller, isRunning: () => false };

    initHome(ctx);
    await flush();
    await flush();

    document.getElementById("start")!.dispatchEvent(new Event("click"));
    await flush();
    await flush();

    expect(controller.startNode).toHaveBeenCalled();
    expect(document.getElementById("msg")!.textContent).toMatch(/already running in another tab/i);
    // Must not leak the raw SDK error-code prefix into the user-facing message.
    expect(document.getElementById("msg")!.textContent).not.toMatch(/NODE_ALREADY_RUNNING/);
  });
});
