import { describe, it, expect } from "vitest";
import { driveButtonView, cloudBackupButtons, drawerBackupStatus, shouldArmGestureReconnect, backupMsgOnStateChange, NODE_STOPPED_BACKUP_MSG } from "./drive-ui";

describe("driveButtonView", () => {
  it("shows a success-styled 'Connected' button when connected", () => {
    const v = driveButtonView(true);
    expect(v.label).toContain("Connected");
    expect(v.className).toContain("btn-success");
    expect(v.className).toContain("btn");
  });

  it("shows the neutral 'Connect Drive' button when not connected", () => {
    const v = driveButtonView(false);
    expect(v.label).toBe("Connect Drive");
    expect(v.className).toContain("btn-secondary");
    expect(v.className).not.toContain("btn-success");
  });
});

describe("cloudBackupButtons", () => {
  it("when connected, 'Back up now' is primary and Reconnect drops to a quiet 'Switch Google account'", () => {
    const v = cloudBackupButtons(true, true);
    expect(v.backupNowPrimary).toBe(true);
    expect(v.connect.primary).toBe(false);
    expect(v.connect.label).toBe("Switch Google account");
  });

  it("when disconnected with a remembered account, the connect button is the primary 'Reconnect'", () => {
    const v = cloudBackupButtons(false, true);
    expect(v.connect.primary).toBe(true);
    expect(v.connect.label).toBe("Reconnect");
    expect(v.backupNowPrimary).toBe(false);
  });

  it("when never connected, the primary button is 'Connect Drive'", () => {
    const v = cloudBackupButtons(false, false);
    expect(v.connect.primary).toBe(true);
    expect(v.connect.label).toBe("Connect Drive");
    expect(v.backupNowPrimary).toBe(false);
  });
});

describe("drawerBackupStatus", () => {
  it("shows 'Syncing ✓' when connected with the node running", () => {
    expect(drawerBackupStatus({ demo: false, configured: true, connected: true, running: true })).toEqual({ label: "Syncing ✓", cls: "ok" });
  });
  it("shows 'Connected' when set up but the node is stopped (or token not live yet)", () => {
    expect(drawerBackupStatus({ demo: false, configured: true, connected: true, running: false })).toEqual({ label: "Connected", cls: "ok" });
    expect(drawerBackupStatus({ demo: false, configured: true, connected: false, running: true })).toEqual({ label: "Connected", cls: "ok" });
  });
  it("shows 'Off' when Drive isn't set up", () => {
    expect(drawerBackupStatus({ demo: false, configured: false, connected: false, running: true })).toEqual({ label: "Off", cls: "warn" });
  });
  it("shows a demo marker in demo, never a real status", () => {
    expect(drawerBackupStatus({ demo: true, configured: true, connected: false, running: true })).toEqual({ label: "Demo", cls: "" });
  });
});

describe("shouldArmGestureReconnect", () => {
  it("arms when disconnected and a prior-account hint exists", () => {
    // GIS needs a user gesture for a token, so a load-time silent reconnect fails;
    // retry on first interaction only if we have an account to silently reconnect.
    expect(shouldArmGestureReconnect(false, "you@gmail.com")).toBe(true);
  });

  it("does not arm when already connected", () => {
    expect(shouldArmGestureReconnect(true, "you@gmail.com")).toBe(false);
  });

  it("does not arm without a prior-account hint", () => {
    expect(shouldArmGestureReconnect(false, null)).toBe(false);
    expect(shouldArmGestureReconnect(false, "")).toBe(false);
  });
});

describe("backupMsgOnStateChange", () => {
  it("shows the stopped hint whenever the node is not running", () => {
    expect(backupMsgOnStateChange(false, "")).toBe(NODE_STOPPED_BACKUP_MSG);
    expect(backupMsgOnStateChange(false, "Downloaded backup.json. Store it safely.")).toBe(NODE_STOPPED_BACKUP_MSG);
  });

  it("clears the stale stopped hint once the node is running", () => {
    // Settings renders before the async auto-start completes, so the stopped hint gets
    // set at init; the state-changed refresh must clear it or it sticks forever.
    expect(backupMsgOnStateChange(true, NODE_STOPPED_BACKUP_MSG)).toBe("");
  });

  it("leaves any other message alone while running", () => {
    // state-changed fires on every channel-state persist — an unconditional clear
    // would wipe a real status like the export-success message within seconds.
    expect(backupMsgOnStateChange(true, "Downloaded backup.json. Store it safely.")).toBeNull();
    expect(backupMsgOnStateChange(true, "")).toBeNull();
  });
});
