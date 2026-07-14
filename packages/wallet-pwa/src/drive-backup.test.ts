import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildTokenClientConfig,
  networkFromBackupFilename,
  pickRestoreNetwork,
  completeDriveRedirect,
  getConnectedEmail,
  DRIVE_HINT_KEY,
} from "./drive-backup";

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

// The installed iOS PWA can't use the GIS popup, so it connects Drive via a full-page OAuth redirect
// that returns through completeDriveRedirect. Previously that path learned the account email only in
// memory, so a full app close (iOS reaping the PWA overnight) wiped it and the onboarding gate
// re-prompted "Connect Google Drive" on the next launch. The account must survive to localStorage.
describe("completeDriveRedirect — remembers the Drive account across an app close", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("persists the learned account email to the onboarding-gate key", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ email: "chad@example.com" }) })) as any;

    const r = completeDriveRedirect("#access_token=ya29.tok&token_type=Bearer&expires_in=3599");
    expect(r.ok).toBe(true);

    // The email is fetched fire-and-forget; once it lands it must be on disk (survives a reload)
    // AND in memory (serves this session) — driveConfigured() reads either.
    await vi.waitFor(() => {
      expect(localStorage.getItem(DRIVE_HINT_KEY)).toBe("chad@example.com");
    });
    expect(getConnectedEmail()).toBe("chad@example.com");
  });
});
