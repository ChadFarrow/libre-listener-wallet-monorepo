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
  cloudBackup: false,
  running: false,
  channels: 0,
  usableChannels: 0,
};

const item = (r: ReturnType<typeof computeChecklist>, key: string) => r.items.find((i) => i.key === key)!;

describe("computeChecklist", () => {
  it("fresh wallet: five steps, create done, backup active", () => {
    const r = computeChecklist(base);
    expect(r.visible).toBe(true);
    expect(r.items.map((i) => i.key)).toEqual(["create", "backup", "cloudBackup", "start", "channel"]);
    expect(item(r, "create").done).toBe(true);
    expect(item(r, "backup").active).toBe(true);
    expect(item(r, "cloudBackup").active).toBe(false);
  });

  it("phrase backed up but no cloud backup: cloud backup is the active step", () => {
    const r = computeChecklist({ ...base, backedUp: true });
    expect(item(r, "backup").done).toBe(true);
    expect(item(r, "cloudBackup").active).toBe(true);
    expect(item(r, "start").active).toBe(false);
  });

  it("both backups done, node stopped: start is the active step", () => {
    const r = computeChecklist({ ...base, backedUp: true, cloudBackup: true });
    expect(item(r, "cloudBackup").done).toBe(true);
    expect(item(r, "start").active).toBe(true);
    expect(item(r, "channel").active).toBe(false);
  });

  it("running with both backups and no channel: get-a-channel is active and enabled", () => {
    const r = computeChecklist({ ...base, backedUp: true, cloudBackup: true, running: true });
    expect(item(r, "start").done).toBe(true);
    const ch = item(r, "channel");
    expect(ch.active).toBe(true);
    expect(ch.actionDisabled).toBe(false);
  });

  it("cloud backup gates the channel: disabled with a connect-backup note even when running", () => {
    const r = computeChecklist({ ...base, backedUp: true, cloudBackup: false, running: true });
    const ch = item(r, "channel");
    expect(ch.actionDisabled).toBe(true);
    expect(ch.note).toBe("Turn on cloud backup first.");
    expect(item(r, "cloudBackup").active).toBe(true);
  });

  it("cloud backup on but node stopped: channel disabled with a start-first note", () => {
    const r = computeChecklist({ ...base, backedUp: true, cloudBackup: true });
    expect(item(r, "channel").actionDisabled).toBe(true);
    expect(item(r, "channel").note).toBe("Start the node first.");
  });

  it("channel pending (not yet usable): step done with an opening note", () => {
    const r = computeChecklist({ ...base, backedUp: true, cloudBackup: true, running: true, channels: 1, usableChannels: 0 });
    const ch = item(r, "channel");
    expect(ch.done).toBe(true);
    expect(ch.note).toBe("Channel opening — this can take a bit.");
  });

  it("funded but NOT phrase-backed up: still visible, backup incomplete", () => {
    const r = computeChecklist({ ...base, backedUp: false, cloudBackup: true, running: true, channels: 1, usableChannels: 1 });
    expect(r.visible).toBe(true);
    expect(item(r, "backup").active).toBe(true);
    expect(item(r, "channel").done).toBe(true);
  });

  it("funded + phrase backed up but no cloud backup: still visible (cloud backup incomplete)", () => {
    const r = computeChecklist({ ...base, backedUp: true, cloudBackup: false, running: true, channels: 1, usableChannels: 1 });
    expect(r.visible).toBe(true);
    expect(item(r, "cloudBackup").active).toBe(true);
  });

  it("both backups done AND has a channel: hidden", () => {
    const r = computeChecklist({ ...base, backedUp: true, cloudBackup: true, running: true, channels: 1, usableChannels: 1 });
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
