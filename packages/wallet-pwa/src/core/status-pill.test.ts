import { describe, it, expect } from "vitest";
import { statusPill } from "./status-pill";

const HEALTHY = {
  hasWallet: true,
  running: true,
  channels: 1,
  usableChannels: 1,
  driveConfigured: true,
  backedUp: true,
};

describe("statusPill", () => {
  it("is hidden when everything is healthy", () => {
    expect(statusPill(HEALTHY)).toBeNull();
  });

  it("is hidden with no wallet (onboarding owns that state)", () => {
    expect(statusPill({ ...HEALTHY, hasWallet: false, running: false, channels: 0, usableChannels: 0 })).toBeNull();
  });

  it("node stopped outranks everything and targets the node screen", () => {
    const p = statusPill({ ...HEALTHY, running: false, channels: 0, driveConfigured: false, backedUp: false });
    expect(p).toMatchObject({ level: "bad", target: "node" });
    expect(p!.text).toMatch(/node/i);
  });

  it("includes the start error reason when present", () => {
    const p = statusPill({ ...HEALTHY, running: false, startError: "Esplora unreachable" });
    expect(p!.text).toContain("Esplora unreachable");
  });

  it("no channel yet → warn targeting get-channel", () => {
    const p = statusPill({ ...HEALTHY, channels: 0, usableChannels: 0 });
    expect(p).toMatchObject({ level: "warn", target: "get-channel" });
    expect(p!.text).toMatch(/channel/i);
  });

  it("channel exists but none usable → info 'opening' targeting channels", () => {
    const p = statusPill({ ...HEALTHY, channels: 1, usableChannels: 0 });
    expect(p).toMatchObject({ level: "info", target: "channels" });
    expect(p!.text).toMatch(/opening/i);
  });

  it("seed not backed up → warn targeting recovery", () => {
    const p = statusPill({ ...HEALTHY, backedUp: false });
    expect(p).toMatchObject({ level: "warn", target: "recovery" });
  });

  it("Drive not configured → warn targeting cloud-backup", () => {
    const p = statusPill({ ...HEALTHY, driveConfigured: false });
    expect(p).toMatchObject({ level: "warn", target: "cloud-backup" });
  });

  it("priority: no-channel outranks backup drift", () => {
    const p = statusPill({ ...HEALTHY, channels: 0, usableChannels: 0, backedUp: false });
    expect(p!.target).toBe("get-channel");
  });
});
