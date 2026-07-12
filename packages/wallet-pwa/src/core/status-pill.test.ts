import { describe, it, expect } from "vitest";
import { statusPill } from "./status-pill";
import type { ChannelLifecycle } from "./channel-lifecycle";

const HEALTHY = {
  hasWallet: true,
  running: true,
  lifecycle: "active" as ChannelLifecycle,
  driveConfigured: true,
  driveConnected: true,
  backedUp: true,
};

describe("statusPill", () => {
  it("is hidden when everything is healthy", () => {
    expect(statusPill(HEALTHY)).toBeNull();
  });

  it("is hidden with no wallet (onboarding owns that state)", () => {
    expect(statusPill({ ...HEALTHY, hasWallet: false, running: false, lifecycle: "none" })).toBeNull();
  });

  it("node stopped outranks everything and targets the node screen", () => {
    const p = statusPill({ ...HEALTHY, running: false, lifecycle: "none", driveConfigured: false, backedUp: false });
    expect(p).toMatchObject({ level: "bad", target: "node" });
    expect(p!.text).toMatch(/node/i);
  });

  it("includes the start error reason when present", () => {
    const p = statusPill({ ...HEALTHY, running: false, startError: "Esplora unreachable" });
    expect(p!.text).toContain("Esplora unreachable");
  });

  it("closed-needs-address → bad, targets the sweep screen (fund-safety prompt)", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "closed-needs-address" });
    expect(p).toMatchObject({ level: "bad", target: "sweep" });
    expect(p!.text).toMatch(/recovery address/i);
  });

  it("closed-recovering → info, targets the sweep screen", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "closed-recovering" });
    expect(p).toMatchObject({ level: "info", target: "sweep" });
    expect(p!.text).toMatch(/recovering/i);
  });

  it("closed-recovered → warn 'get a new one', NOT first-run copy", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "closed-recovered" });
    expect(p).toMatchObject({ level: "warn", target: "get-channel" });
    expect(p!.text).toMatch(/closed/i);
    expect(p!.text).not.toMatch(/no channel yet/i);
  });

  it("none (never had) keeps the first-run copy", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "none" });
    expect(p).toMatchObject({ level: "warn", target: "get-channel" });
    expect(p!.text).toMatch(/no channel yet/i);
  });

  it("opening → info targeting channels (unchanged copy)", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "opening" });
    expect(p).toMatchObject({ level: "info", target: "channels" });
    expect(p!.text).toMatch(/opening/i);
  });

  it("seed not backed up → warn targeting recovery", () => {
    expect(statusPill({ ...HEALTHY, backedUp: false })).toMatchObject({ level: "warn", target: "recovery" });
  });

  it("Drive not configured → warn targeting cloud-backup", () => {
    expect(statusPill({ ...HEALTHY, driveConfigured: false })).toMatchObject({ level: "warn", target: "cloud-backup" });
  });

  it("Drive configured but disconnected → warn targeting reconnect-drive (the iOS one-tap nag)", () => {
    const p = statusPill({ ...HEALTHY, driveConnected: false });
    expect(p).toMatchObject({ level: "warn", target: "reconnect-drive" });
    expect(p!.text).toMatch(/reconnect/i);
  });

  it("not-configured outranks disconnected (set up before reconnect)", () => {
    expect(statusPill({ ...HEALTHY, driveConfigured: false, driveConnected: false })).toMatchObject({
      target: "cloud-backup",
    });
  });

  it("seed-backup outranks the drive-reconnect nag", () => {
    expect(statusPill({ ...HEALTHY, backedUp: false, driveConnected: false })).toMatchObject({ target: "recovery" });
  });

  it("priority: closed states outrank backup drift", () => {
    const p = statusPill({ ...HEALTHY, lifecycle: "closed-needs-address", backedUp: false, driveConfigured: false });
    expect(p!.target).toBe("sweep");
  });
});
