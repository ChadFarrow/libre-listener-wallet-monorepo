import { describe, it, expect } from "vitest";
import { balanceDisplay } from "./balance-display";

describe("balanceDisplay", () => {
  it("shows the real spendable when a channel is contributing liquidity", () => {
    const v = balanceDisplay({ balance: { spendableSat: 4200, receivableSat: 8000 }, hasChannelState: true, lastShownSats: 100 });
    expect(v).toEqual({ sats: 4200, stale: false });
  });

  it("holds the last value during a transient dip (both sides 0 — no usable channel contributing)", () => {
    // The 1549 → 0 → 1549 flash: a monitor-persist / reconnect dip zeroes both sides for a beat.
    const v = balanceDisplay({ balance: { spendableSat: 0, receivableSat: 0 }, hasChannelState: true, lastShownSats: 1549 });
    expect(v).toEqual({ sats: 1549, stale: true });
  });

  it("shows the loading placeholder (null), not a hard 0, during a dip with no cached value", () => {
    const v = balanceDisplay({ balance: { spendableSat: 0, receivableSat: 0 }, hasChannelState: true, lastShownSats: null });
    expect(v).toEqual({ sats: null, stale: true });
  });

  it("shows a genuine 0 when the channel is spent down (receivable still present)", () => {
    // Spendable 0 but receivable > 0 → a real usable channel with no outbound, not a dip.
    const v = balanceDisplay({ balance: { spendableSat: 0, receivableSat: 50000 }, hasChannelState: true, lastShownSats: 4200 });
    expect(v).toEqual({ sats: 0, stale: false });
  });

  it("shows a real 0 for a brand-new wallet with no channel state (not loading)", () => {
    const v = balanceDisplay({ balance: { spendableSat: 0, receivableSat: 0 }, hasChannelState: false, lastShownSats: null });
    expect(v).toEqual({ sats: 0, stale: false });
  });

  it("shows the placeholder (null) when the node is stopped — no stale funds", () => {
    const v = balanceDisplay({ balance: null, hasChannelState: true, lastShownSats: 4200 });
    expect(v).toEqual({ sats: null, stale: false });
  });
});
