import { describe, it, expect } from "vitest";
import { buildTokenClientConfig, networkFromBackupFilename, pickRestoreNetwork } from "./drive-backup";

describe("networkFromBackupFilename", () => {
  it("extracts the network from a backup filename", () => {
    expect(networkFromBackupFilename("libre-wallet-backup-mainnet.json")).toBe("mainnet");
    expect(networkFromBackupFilename("libre-wallet-backup-signet.json")).toBe("signet");
    expect(networkFromBackupFilename("libre-wallet-backup-regtest.json")).toBe("regtest");
  });
  it("returns null for unrelated names", () => {
    expect(networkFromBackupFilename("something-else.json")).toBeNull();
    expect(networkFromBackupFilename("libre-wallet-backup-.json")).toBeNull();
  });
});

describe("pickRestoreNetwork", () => {
  it("prefers mainnet when present", () => {
    expect(pickRestoreNetwork(["signet", "mainnet"])).toBe("mainnet");
  });
  it("falls back to the only/first network", () => {
    expect(pickRestoreNetwork(["signet"])).toBe("signet");
    expect(pickRestoreNetwork(["regtest", "signet"])).toBe("regtest");
  });
  it("returns null when there are no backups", () => {
    expect(pickRestoreNetwork([])).toBeNull();
  });
});

describe("buildTokenClientConfig", () => {
  const CLIENT_ID = "abc.apps.googleusercontent.com";

  it("requests both the appdata and email scopes", () => {
    const cfg = buildTokenClientConfig(CLIENT_ID);
    expect(cfg.scope).toContain("https://www.googleapis.com/auth/drive.appdata");
    expect(cfg.scope).toContain("email");
    expect(cfg.client_id).toBe(CLIENT_ID);
  });

  it("uses an interactive prompt (no popup unless needed) by default", () => {
    const cfg = buildTokenClientConfig(CLIENT_ID);
    expect(cfg.prompt).toBe("");
    expect(cfg.hint).toBeUndefined();
  });

  it("uses a silent prompt with a login_hint for silent reconnect", () => {
    const cfg = buildTokenClientConfig(CLIENT_ID, { silent: true, hint: "user@example.com" });
    expect(cfg.prompt).toBe("none");
    expect(cfg.hint).toBe("user@example.com");
  });

  it("omits the hint when none is known, even when silent", () => {
    const cfg = buildTokenClientConfig(CLIENT_ID, { silent: true });
    expect(cfg.prompt).toBe("none");
    expect(cfg.hint).toBeUndefined();
  });
});
