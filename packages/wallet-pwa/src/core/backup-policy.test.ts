import { describe, it, expect } from "vitest";
import { isMobileUa, shouldAutoDownload } from "./backup-policy";

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
