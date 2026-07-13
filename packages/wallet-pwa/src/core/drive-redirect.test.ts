import { describe, it, expect } from "vitest";
import { buildDriveAuthUrl, parseDriveOAuthFragment } from "./drive-redirect";

describe("buildDriveAuthUrl", () => {
  it("builds an implicit-grant auth URL with the required params", () => {
    const url = buildDriveAuthUrl({
      clientId: "cid.apps.googleusercontent.com",
      redirectUri: "https://libre-wallet-pwa.pages.dev/",
      scope: "https://www.googleapis.com/auth/drive.appdata email",
      state: "nonce123",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(u.searchParams.get("redirect_uri")).toBe("https://libre-wallet-pwa.pages.dev/");
    expect(u.searchParams.get("response_type")).toBe("token"); // implicit grant, not code
    expect(u.searchParams.get("scope")).toContain("drive.appdata");
    expect(u.searchParams.get("state")).toBe("nonce123");
    expect(u.searchParams.get("include_granted_scopes")).toBe("true");
    expect(u.searchParams.get("login_hint")).toBeNull(); // omitted when no hint
  });

  it("includes login_hint when provided", () => {
    const url = buildDriveAuthUrl({
      clientId: "cid",
      redirectUri: "https://x/",
      scope: "s",
      state: "n",
      loginHint: "chad@example.com",
    });
    expect(new URL(url).searchParams.get("login_hint")).toBe("chad@example.com");
  });
});

describe("parseDriveOAuthFragment", () => {
  it("extracts token, state and expiry from a success fragment", () => {
    const r = parseDriveOAuthFragment("#access_token=ya29.abc&state=nonce123&expires_in=3599&token_type=Bearer");
    expect(r).not.toBeNull();
    expect(r!.accessToken).toBe("ya29.abc");
    expect(r!.state).toBe("nonce123");
    expect(r!.expiresIn).toBe(3599);
    expect(r!.error).toBeNull();
  });

  it("works whether or not the leading # is present", () => {
    expect(parseDriveOAuthFragment("access_token=t")!.accessToken).toBe("t");
  });

  it("returns null for a non-OAuth fragment (normal load / #demo)", () => {
    expect(parseDriveOAuthFragment("")).toBeNull();
    expect(parseDriveOAuthFragment("#demo")).toBeNull();
    expect(parseDriveOAuthFragment("#/some/route")).toBeNull();
  });

  it("surfaces an OAuth error return (no token)", () => {
    const r = parseDriveOAuthFragment("#error=access_denied&state=n");
    expect(r).not.toBeNull();
    expect(r!.error).toBe("access_denied");
    expect(r!.accessToken).toBe("");
  });
});
