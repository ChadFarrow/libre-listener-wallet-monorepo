import { describe, it, expect, beforeEach } from "vitest";
import {
  computeChecklist,
  seedBackedUpKey,
  getSeedBackedUp,
  setSeedBackedUp,
  type ChecklistInputs,
} from "./onboarding";

const base: ChecklistInputs = {
  hasWallet: true,
  backedUp: false,
  running: false,
  channels: 0,
  usableChannels: 0,
};

const item = (r: ReturnType<typeof computeChecklist>, key: string) => r.items.find((i) => i.key === key)!;

describe("computeChecklist", () => {
  it("fresh wallet: four steps, create done, backup active", () => {
    const r = computeChecklist(base);
    expect(r.visible).toBe(true);
    expect(r.items.map((i) => i.key)).toEqual(["create", "backup", "start", "channel"]);
    expect(item(r, "create").done).toBe(true);
    expect(item(r, "backup").active).toBe(true);
    expect(item(r, "start").active).toBe(false);
  });

  it("backed up but node stopped: start is the active step", () => {
    const r = computeChecklist({ ...base, backedUp: true });
    expect(item(r, "backup").done).toBe(true);
    expect(item(r, "start").active).toBe(true);
    expect(item(r, "channel").active).toBe(false);
  });

  it("running with no channel: get-a-channel is active and enabled", () => {
    const r = computeChecklist({ ...base, backedUp: true, running: true });
    expect(item(r, "start").done).toBe(true);
    const ch = item(r, "channel");
    expect(ch.active).toBe(true);
    expect(ch.actionDisabled).toBe(false);
  });

  it("get-a-channel action is disabled until the node runs", () => {
    const r = computeChecklist({ ...base, backedUp: true });
    expect(item(r, "channel").actionDisabled).toBe(true);
    expect(item(r, "channel").note).toBe("Start the node first.");
  });

  it("channel pending (not yet usable): step done with an opening note", () => {
    const r = computeChecklist({ ...base, backedUp: true, running: true, channels: 1, usableChannels: 0 });
    const ch = item(r, "channel");
    expect(ch.done).toBe(true);
    expect(ch.note).toBe("Channel opening — this can take a bit.");
  });

  it("funded but NOT backed up: still visible, only backup incomplete", () => {
    const r = computeChecklist({ ...base, backedUp: false, running: true, channels: 1, usableChannels: 1 });
    expect(r.visible).toBe(true);
    expect(item(r, "backup").active).toBe(true);
    expect(item(r, "channel").done).toBe(true);
  });

  it("backed up AND has a channel: hidden", () => {
    const r = computeChecklist({ ...base, backedUp: true, running: true, channels: 1, usableChannels: 1 });
    expect(r.visible).toBe(false);
  });

  it("no wallet: never visible", () => {
    expect(computeChecklist({ ...base, hasWallet: false }).visible).toBe(false);
  });
});

describe("seedBackedUp marker (per network)", () => {
  beforeEach(() => localStorage.clear());

  it("keys by network", () => {
    expect(seedBackedUpKey("mainnet")).toBe("libre_seed_backed_up:mainnet");
    expect(seedBackedUpKey("signet")).toBe("libre_seed_backed_up:signet");
  });

  it("round-trips and is isolated per network", () => {
    expect(getSeedBackedUp("mainnet")).toBe(false);
    setSeedBackedUp("mainnet");
    expect(getSeedBackedUp("mainnet")).toBe(true);
    expect(getSeedBackedUp("signet")).toBe(false);
  });
});
