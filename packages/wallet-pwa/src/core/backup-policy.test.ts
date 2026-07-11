import { describe, it, expect } from "vitest";
import { isMobileUa, shouldAutoDownload, shouldDriveAutoSync } from "./backup-policy";

describe("isMobileUa", () => {
  it("detects phones and tablets", () => {
    expect(isMobileUa("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe(true);
    expect(isMobileUa("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36")).toBe(true);
    expect(isMobileUa("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe(true);
  });

  it("treats desktop UAs (and empty) as not mobile", () => {
    expect(isMobileUa("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe(false);
    expect(isMobileUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
    expect(isMobileUa("")).toBe(false);
  });
});

describe("shouldAutoDownload", () => {
  it("runs only on desktop, with the toggle on, and Drive NOT configured", () => {
    expect(shouldAutoDownload({ toggleOn: true, driveConfigured: false, mobile: false })).toBe(true);
  });

  it("Drive configured wins over the toggle (Drive replaces local downloads)", () => {
    expect(shouldAutoDownload({ toggleOn: true, driveConfigured: true, mobile: false })).toBe(false);
  });

  it("never auto-downloads on mobile (Drive is the only backup channel there)", () => {
    expect(shouldAutoDownload({ toggleOn: true, driveConfigured: false, mobile: true })).toBe(false);
    expect(shouldAutoDownload({ toggleOn: true, driveConfigured: true, mobile: true })).toBe(false);
  });

  it("off toggle means off", () => {
    expect(shouldAutoDownload({ toggleOn: false, driveConfigured: false, mobile: false })).toBe(false);
  });
});

describe("shouldDriveAutoSync", () => {
  const base = { event: "state-changed", demo: false, running: true, driveConnected: true };

  it("syncs on a state-changed while running with Drive connected (the peer-connect → backup path)", () => {
    expect(shouldDriveAutoSync(base)).toBe(true);
  });

  it("ignores non state-changed events", () => {
    expect(shouldDriveAutoSync({ ...base, event: "payment" })).toBe(false);
  });

  it("never syncs in demo (must not touch Drive)", () => {
    expect(shouldDriveAutoSync({ ...base, demo: true })).toBe(false);
  });

  it("skips when the node is stopped (exportState needs it) or Drive has no live token", () => {
    expect(shouldDriveAutoSync({ ...base, running: false })).toBe(false);
    expect(shouldDriveAutoSync({ ...base, driveConnected: false })).toBe(false);
  });
});
