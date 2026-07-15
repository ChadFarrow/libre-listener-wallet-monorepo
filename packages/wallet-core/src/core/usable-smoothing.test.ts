import { describe, it, expect } from "vitest";
import { smoothUsable, type UsableSmootherState } from "./usable-smoothing";

// The drawer's "usable/total" count (and the home pill's channel state) sample is_usable at
// state-changed time — exactly when a monitor persist briefly pauses the channel — so a healthy
// wallet flashed "0/1" during e.g. a Drive sync. Same transient class balance-display smooths.

describe("smoothUsable", () => {
  it("passes the first reading through", () => {
    const r = smoothUsable(undefined, 1, 1, 1000);
    expect(r.shown).toBe(1);
  });

  it("holds the last-good count through a short dip", () => {
    const s = smoothUsable(undefined, 1, 1, 1000).state;
    const dip = smoothUsable(s, 0, 1, 3000);
    expect(dip.shown).toBe(1); // within grace: keep showing 1/1
  });

  it("shows the real count once a dip outlives the grace window", () => {
    let s: UsableSmootherState | undefined;
    s = smoothUsable(s, 1, 1, 1000).state;
    s = smoothUsable(s, 0, 1, 3000).state; // dip starts
    const later = smoothUsable(s, 0, 1, 3000 + 10_001);
    expect(later.shown).toBe(0); // genuine outage: tell the truth
  });

  it("clears the dip when the channel comes back", () => {
    let s: UsableSmootherState | undefined;
    s = smoothUsable(s, 1, 1, 1000).state;
    s = smoothUsable(s, 0, 1, 3000).state;
    s = smoothUsable(s, 1, 1, 5000).state;
    // a new dip later gets a fresh grace window
    const dip2 = smoothUsable(s, 0, 1, 20_000);
    expect(dip2.shown).toBe(1);
  });

  it("resets on a channel-count change (open/close is a real event, show it immediately)", () => {
    const s = smoothUsable(undefined, 2, 2, 1000).state;
    const closed = smoothUsable(s, 0, 1, 1500); // one channel closed
    expect(closed.shown).toBe(0);
  });

  it("never holds when there are no channels", () => {
    const r = smoothUsable(undefined, 0, 0, 1000);
    expect(r.shown).toBe(0);
  });

  it("an increase always shows immediately", () => {
    const s = smoothUsable(undefined, 1, 2, 1000).state;
    const up = smoothUsable(s, 2, 2, 1100);
    expect(up.shown).toBe(2);
  });
});
