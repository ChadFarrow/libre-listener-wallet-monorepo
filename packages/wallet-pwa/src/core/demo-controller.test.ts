import { describe, it, expect, vi, afterEach } from "vitest";
import { DemoController } from "./demo-controller";
import { demoState } from "./demo-mode";

afterEach(() => {
  vi.useRealTimers();
  demoState.seedBackedUp = false;
  demoState.driveConfigured = false;
});

describe("DemoController", () => {
  it("starts with no wallet, creates one running, and resets clean", async () => {
    const demo = new DemoController();
    let s = await demo.getState();
    expect(s.hasSeed).toBe(false);
    expect(s.running).toBe(false);

    await demo.createWallet();
    s = await demo.getState();
    expect(s.hasSeed).toBe(true);
    expect(s.running).toBe(true);
    expect(s.nodeId).toBeTruthy();

    demoState.seedBackedUp = true;
    await demo.resetWallet();
    s = await demo.getState();
    expect(s.hasSeed).toBe(false);
    expect(demoState.seedBackedUp).toBe(false); // demo markers reset with the demo wallet
  });

  it("walks an LSP order to completed on a timer and opens the channel — no payment needed", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const demo = new DemoController();
    await demo.createWallet();
    const order = await demo.purchaseLSPS1Capacity({ amountSats: 150_000 });
    expect(order.invoice).toContain("demo");

    let o = (await demo.getLSPS1Order("x", order.orderId)) as { order_state: string };
    expect(o.order_state).toBe("CREATED");

    vi.setSystemTime(1_700_000_000_000 + 9_000);
    o = (await demo.getLSPS1Order("x", order.orderId)) as { order_state: string };
    expect(o.order_state).toBe("COMPLETED");

    const s = await demo.getState();
    expect(s.channels).toBe(1);
    expect(s.balance!.receivableSat).toBeGreaterThan(100_000);
  });

  it("auto-settles a minted invoice into balance + history", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    const demo = new DemoController();
    await demo.createWallet();
    const order = await demo.purchaseLSPS1Capacity({ amountSats: 150_000 });
    vi.setSystemTime(1_700_000_000_000 + 9_000);
    await demo.getLSPS1Order("x", order.orderId); // opens the channel

    await demo.createInvoice(5000);
    await vi.advanceTimersByTimeAsync(6_500);
    const s = await demo.getState();
    expect(s.balance!.spendableSat).toBe(5000);
    const payments = await demo.getPayments();
    expect(payments[0]).toMatchObject({ direction: "received", status: "settled", amountSats: 5000 });
  });
});
