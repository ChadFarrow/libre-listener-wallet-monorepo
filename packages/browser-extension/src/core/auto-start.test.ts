import { describe, it, expect } from "vitest";
import {
  AUTO_START_KEY,
  isAutoStartEnabled,
  autoStartPlan,
  connectWithRetry,
  shouldReconnectPeer,
  PEER_CONNECT_DELAYS_MS,
} from "./auto-start";

describe("isAutoStartEnabled", () => {
  it("defaults ON: unset and '1' are enabled, only an explicit '0' disables", () => {
    expect(isAutoStartEnabled(null)).toBe(true);
    expect(isAutoStartEnabled("1")).toBe(true);
    expect(isAutoStartEnabled("0")).toBe(false);
  });

  it("pins the storage key", () => {
    expect(AUTO_START_KEY).toBe("auto_start");
  });
});

describe("autoStartPlan", () => {
  const base = { flagRaw: null, hasSeed: true, hasChannelState: true, createdNew: false };

  it("funded wallet: start AND connect peer", () => {
    expect(autoStartPlan(base)).toEqual({ start: true, connectPeer: true });
  });

  it("flag disabled: does nothing", () => {
    const p = autoStartPlan({ ...base, flagRaw: "0" });
    expect(p.start).toBe(false);
    expect(p.connectPeer).toBe(false);
    expect(p.reason).toBeTruthy();
  });

  it("no seed: does nothing", () => {
    const p = autoStartPlan({ ...base, hasSeed: false });
    expect(p.start).toBe(false);
    expect(p.connectPeer).toBe(false);
  });

  // THE force-close guard: a bare seed that wasn't created here must never boot unattended —
  // an empty ChannelManager that connects the peer force-closes the real channel on
  // channel_reestablish (documented mainnet failure).
  it("seed without channel state, NOT created here: silently skips", () => {
    const p = autoStartPlan({ ...base, hasChannelState: false, createdNew: false });
    expect(p.start).toBe(false);
    expect(p.connectPeer).toBe(false);
    expect(p.reason).toMatch(/restore/i);
  });

  it("brand-new unfunded wallet (created here): starts but never auto-dials", () => {
    expect(autoStartPlan({ ...base, hasChannelState: false, createdNew: true })).toEqual({
      start: true,
      connectPeer: false,
    });
  });
});

describe("connectWithRetry", () => {
  const instant = () => Promise.resolve(); // no real waiting in tests

  it("returns true on first success without sleeping", async () => {
    let calls = 0;
    const ok = await connectWithRetry(
      async () => {
        calls++;
      },
      { sleep: instant }
    );
    expect(ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("retries through the schedule then succeeds", async () => {
    let calls = 0;
    const slept: number[] = [];
    const ok = await connectWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("bridge not up yet");
      },
      { delaysMs: [10, 20, 30], sleep: async (ms) => void slept.push(ms) }
    );
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(slept).toEqual([10, 20]); // waited delays[0] and delays[1] between attempts
  });

  it("gives up after exhausting the schedule (delays.length + 1 attempts)", async () => {
    let calls = 0;
    const ok = await connectWithRetry(
      async () => {
        calls++;
        throw new Error("nope");
      },
      { delaysMs: [1, 2], sleep: instant }
    );
    expect(ok).toBe(false);
    expect(calls).toBe(3);
  });

  it("aborts when shouldContinue turns false (node stopped mid-retry)", async () => {
    let calls = 0;
    const ok = await connectWithRetry(
      async () => {
        calls++;
        throw new Error("nope");
      },
      { delaysMs: [1, 2, 3], sleep: instant, shouldContinue: () => calls < 2 }
    );
    expect(ok).toBe(false);
    expect(calls).toBe(2); // third attempt never dialed
  });

  it("reports each failed attempt (1-indexed)", async () => {
    const attempts: number[] = [];
    await connectWithRetry(
      async () => {
        throw new Error("nope");
      },
      { delaysMs: [1], sleep: instant, onAttemptFailed: (n) => void attempts.push(n) }
    );
    expect(attempts).toEqual([1, 2]);
  });

  it("boot schedule is 2s/4s/8s/16s/30s", () => {
    expect([...PEER_CONNECT_DELAYS_MS]).toEqual([2000, 4000, 8000, 16000, 30000]);
  });
});

describe("shouldReconnectPeer (post-start empty/lost-state guard)", () => {
  it("only auto-dials when the wallet actually holds a channel", () => {
    expect(shouldReconnectPeer(1)).toBe(true);
    expect(shouldReconnectPeer(2)).toBe(true);
    // The incident: an empty/lost-state copy (0 channels) must NOT dial, or it force-closes the
    // channel the peer still holds.
    expect(shouldReconnectPeer(0)).toBe(false);
  });

  it("treats junk counts as 'do not dial' (fail safe)", () => {
    expect(shouldReconnectPeer(NaN)).toBe(false);
    expect(shouldReconnectPeer(-1)).toBe(false);
  });
});
