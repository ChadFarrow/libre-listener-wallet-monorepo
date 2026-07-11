import { describe, it, expect } from "vitest";
import { balanceDisplay } from "./balance-display";

describe("balanceDisplay", () => {
  it("shows the real spendable when a usable channel is present", () => {
    const v = balanceDisplay({ balance: { spendableSat: 4200 }, channels: 1, usableChannels: 1, lastShownSats: 100 });
    expect(v).toEqual({ sats: 4200, stale: false });
  });

  it("holds the last value instead of flashing 0 while the peer reconnects (channel exists, none usable)", () => {
    const v = balanceDisplay({ balance: { spendableSat: 0 }, channels: 1, usableChannels: 0, lastShownSats: 4200 });
    expect(v).toEqual({ sats: 4200, stale: true });
  });

  it("shows a genuine 0 when the channel is usable (spent down)", () => {
    const v = balanceDisplay({ balance: { spendableSat: 0 }, channels: 1, usableChannels: 1, lastShownSats: 4200 });
    expect(v).toEqual({ sats: 0, stale: false });
  });

  it("shows 0 on first reading even if reconnecting (no last value to hold)", () => {
    const v = balanceDisplay({ balance: { spendableSat: 0 }, channels: 1, usableChannels: 0, lastShownSats: null });
    expect(v).toEqual({ sats: 0, stale: false });
  });

  it("shows the placeholder (null) when the node is stopped — no stale funds", () => {
    const v = balanceDisplay({ balance: null, channels: 1, usableChannels: 0, lastShownSats: 4200 });
    expect(v).toEqual({ sats: null, stale: false });
  });
});
