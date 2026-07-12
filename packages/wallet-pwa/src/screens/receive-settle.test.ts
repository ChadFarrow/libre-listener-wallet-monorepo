import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaymentRecord } from "@libre/shared";
import { initScreens } from "./index";
import { showScreen } from "../ui/nav";
import { emitControllerEvent } from "../core/events";
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

// Regression: paying the invoice shown on the Receive screen gave NO feedback — the screen
// just sat there (reported live 2026-07-11). The screen now watches the payment log for a
// newly settled received record and flips to a full-cover "Payment received" confirmation.
describe("receive screen payment confirmation", () => {
  const payments: PaymentRecord[] = [];

  function makeCtx(): AppContext {
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
        balance: { spendableSat: 20_000, receivableSat: 100_000 },
      }),
      getPayments: vi.fn().mockImplementation(() => Promise.resolve([...payments])),
      getChannels: vi.fn().mockResolvedValue([]),
      listPeers: vi.fn().mockResolvedValue([]),
      getBalance: vi.fn().mockResolvedValue({ spendableSat: 20_000, receivableSat: 100_000 }),
      createInvoice: vi.fn().mockResolvedValue({ paymentRequest: "lnbc50u1invoicestub" }),
    } as unknown as WalletController;
    return { controller, isRunning: () => true, keepAlive: { start() {}, stop() {}, unlock() {}, isActive: () => false, needsActivation: () => false } };
  }

  beforeEach(() => {
    loadMarkup();
    localStorage.clear();
    payments.length = 0;
  });

  it("shows the paid cover with the amount when a received payment settles, and Done returns home", async () => {
    initScreens(makeCtx());
    await flush();

    showScreen("screen-receive");
    await flush();
    await flush(); // let onShow's baseline snapshot + mint settle

    const cover = document.getElementById("recv-result")!;
    expect(cover.classList.contains("hidden")).toBe(true);

    payments.push({
      id: "claimhash",
      direction: "received",
      status: "settled",
      amountSats: 5000,
      timestamp: Date.now(),
      settledAt: Date.now(),
    });
    emitControllerEvent("state-changed");
    await flush();
    await flush();

    expect(cover.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("recv-result-amount")!.textContent).toContain("5,000");

    document.getElementById("recv-result-done")!.dispatchEvent(new Event("click"));
    await flush();
    expect(document.getElementById("screen-home")!.classList.contains("current")).toBe(true);
    expect(document.getElementById("recv-result")!.classList.contains("hidden")).toBe(true);
  });

  it("ignores payments that settled before the screen opened and sent records", async () => {
    payments.push({
      id: "old-receive",
      direction: "received",
      status: "settled",
      amountSats: 1234,
      timestamp: Date.now() - 60_000,
      settledAt: Date.now() - 60_000,
    });
    initScreens(makeCtx());
    await flush();

    showScreen("screen-receive");
    await flush();
    await flush();

    payments.push({
      id: "outbound",
      direction: "sent",
      status: "settled",
      amountSats: 42,
      timestamp: Date.now(),
      settledAt: Date.now(),
    });
    emitControllerEvent("state-changed");
    await flush();
    await flush();

    expect(document.getElementById("recv-result")!.classList.contains("hidden")).toBe(true);
  });
});
