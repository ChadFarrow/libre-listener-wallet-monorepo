import { describe, it, expect } from "vitest";
import { buildTokenClientConfig } from "./drive-backup";

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
