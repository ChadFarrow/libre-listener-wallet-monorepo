import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildTokenClientConfig,
  networkFromBackupFilename,
  pickRestoreNetwork,
  completeDriveRedirect,
  getConnectedEmail,
  isDriveConfiguredPersisted,
  readAppDataFile,
  writeAppDataFileSyncKeepalive,
  __resetAppDataFileIdCache,
  disconnect as disconnectDrive,
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

  it("marks Drive configured synchronously — before, and independent of, the email lookup", () => {
    // The email lookup fails outright; the durable configured flag must not depend on it.
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as any;

    expect(isDriveConfiguredPersisted()).toBe(false);
    const r = completeDriveRedirect("#access_token=ya29.tok2&token_type=Bearer&expires_in=3599");
    expect(r.ok).toBe(true);
    // Set the instant the token lands (synchronous), not awaiting the fetch.
    expect(isDriveConfiguredPersisted()).toBe(true);
  });

  it("keeps the gate satisfied even when the email lookup never yields a hint", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as any;
    completeDriveRedirect("#access_token=ya29.tok3&token_type=Bearer");
    await new Promise((res) => setTimeout(res, 0)); // let the fire-and-forget email lookup settle
    expect(localStorage.getItem(DRIVE_HINT_KEY)).toBeNull(); // no hint learned…
    expect(isDriveConfiguredPersisted()).toBe(true); // …but Drive is still remembered as configured
  });
});

// The pagehide write. Everything here exists because a page dies long before an awaited request is
// issued — so this write must be ISSUED with nothing awaited in front of it, or it doesn't happen at
// all. That was the actual state of the old "keepalive flush": it awaited an export and an id lookup
// first, so the fetch was never issued and the mitigation the docs leaned on did not exist (#90).
describe("writeAppDataFileSyncKeepalive", () => {
  beforeEach(() => {
    __resetAppDataFileIdCache();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function connectAndResolveId() {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/drive/v3/files?spaces=appDataFolder")) {
        return { ok: true, json: async () => ({ files: [{ id: "file-123", modifiedTime: "t" }] }) };
      }
      return { ok: true, text: async () => "{}", json: async () => ({ email: "chad@example.com" }) };
    }) as any;
    completeDriveRedirect("#access_token=ya29.sync-tok&token_type=Bearer&expires_in=3599");
    await readAppDataFile("libre-wallet-lease-mainnet.json"); // resolves + caches the id
  }

  it("issues a keepalive PATCH SYNCHRONOUSLY against the cached id", async () => {
    await connectAndResolveId();
    const calls: Array<[string, any]> = [];
    globalThis.fetch = vi.fn((url: any, init: any) => {
      calls.push([String(url), init]);
      return new Promise(() => {}); // never settles — we assert on issuance, not completion
    }) as any;

    const issued = writeAppDataFileSyncKeepalive("libre-wallet-lease-mainnet.json", '{"phase":"released"}');

    // Asserted with NO await in between: the request must already be out by the time we return.
    expect(issued).toBe(true);
    expect(calls.length).toBe(1);
    const [url, init] = calls[0];
    expect(url).toContain("/upload/drive/v3/files/file-123");
    expect(init.method).toBe("PATCH");
    expect(init.keepalive).toBe(true);
    expect(init.headers.Authorization).toBe("Bearer ya29.sync-tok");
    expect(init.body).toBe('{"phase":"released"}');
  });

  it("reports false rather than lying when it cannot issue — unknown file id", async () => {
    await connectAndResolveId();
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as any;
    expect(writeAppDataFileSyncKeepalive("never-resolved.json", "{}")).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports false when there is no access token (nothing to authorize with)", async () => {
    // Resolve the id FIRST so the id isn't what's failing — then drop the token.
    await connectAndResolveId();
    disconnectDrive();
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as any;
    expect(writeAppDataFileSyncKeepalive("libre-wallet-lease-mainnet.json", "{}")).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled(); // never an unauthenticated write
  });
});
