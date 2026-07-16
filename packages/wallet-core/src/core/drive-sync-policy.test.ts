import { describe, it, expect } from "vitest";
import { shouldDriveAutoSync, DRIVE_SYNC_DEBOUNCE_MS } from "./drive-sync-policy";

describe("shouldDriveAutoSync", () => {
  const base = { event: "state-changed", demo: false, running: true, driveConnected: true };

  it("syncs on a state change while running with Drive connected", () => {
    expect(shouldDriveAutoSync(base)).toBe(true);
  });

  it("ignores non-state-change events (display-only refreshes must not spam Drive)", () => {
    expect(shouldDriveAutoSync({ ...base, event: "drive-sync" })).toBe(false);
    expect(shouldDriveAutoSync({ ...base, event: "balance" })).toBe(false);
  });

  it("never syncs in demo, stopped, or Drive-disconnected", () => {
    expect(shouldDriveAutoSync({ ...base, demo: true })).toBe(false);
    expect(shouldDriveAutoSync({ ...base, running: false })).toBe(false); // exportState needs the node
    expect(shouldDriveAutoSync({ ...base, driveConnected: false })).toBe(false);
  });

  // The whole reason this predicate is shared rather than per-app: an origin that holds the wallet
  // but doesn't push state to Drive leaves its successor a backup the channel has outrun. The embed
  // had NO auto-sync at all, and a takeover restored a 9-commitments-stale backup onto a live
  // mainnet channel → force-close (#90). Both hosts must answer this question identically.
  it("keeps the un-flushed window small enough that a crash gap is a halt, not a lost channel", () => {
    expect(DRIVE_SYNC_DEBOUNCE_MS).toBeLessThanOrEqual(5_000);
  });
});
