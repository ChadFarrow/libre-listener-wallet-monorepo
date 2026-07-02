import { describe, it, expect } from "vitest";
import { buildAuthUrl, parseTokenFromRedirect, AUTH_SCOPES } from "./drive-oauth";

const REDIRECT = "https://abc123.chromiumapp.org/";

describe("buildAuthUrl", () => {
  it("builds a token-flow authorization URL with the appdata scope", () => {
    const url = new URL(buildAuthUrl("client.apps.googleusercontent.com", REDIRECT));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe("client.apps.googleusercontent.com");
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("response_type")).toBe("token");
    expect(p.get("scope")).toBe(AUTH_SCOPES);
    expect(AUTH_SCOPES).toContain("drive.appdata");
  });

  it("adds login_hint and prompt when provided (silent reconnect)", () => {
    const p = new URL(buildAuthUrl("cid", REDIRECT, { hint: "user@example.com", prompt: "none" }))
      .searchParams;
    expect(p.get("login_hint")).toBe("user@example.com");
    expect(p.get("prompt")).toBe("none");
  });

  it("omits login_hint/prompt when not provided", () => {
    const p = new URL(buildAuthUrl("cid", REDIRECT)).searchParams;
    expect(p.has("login_hint")).toBe(false);
    expect(p.has("prompt")).toBe(false);
  });

  it("throws without a client id", () => {
    expect(() => buildAuthUrl("", REDIRECT)).toThrow(/Client ID/);
  });
});

describe("parseTokenFromRedirect", () => {
  it("extracts the access token and expiry from the fragment", () => {
    const { accessToken, expiresInSec } = parseTokenFromRedirect(
      `${REDIRECT}#access_token=ya29.TOKEN&token_type=Bearer&expires_in=3599&scope=x`
    );
    expect(accessToken).toBe("ya29.TOKEN");
    expect(expiresInSec).toBe(3599);
  });

  it("defaults expiry to 3600 when absent", () => {
    expect(parseTokenFromRedirect(`${REDIRECT}#access_token=T`).expiresInSec).toBe(3600);
  });

  it("throws on a denial (error param)", () => {
    expect(() => parseTokenFromRedirect(`${REDIRECT}?error=access_denied`)).toThrow(/access_denied/);
  });

  it("throws when the flow was cancelled (no redirect url)", () => {
    expect(() => parseTokenFromRedirect(undefined)).toThrow(/cancelled/);
  });

  it("throws when no token is present", () => {
    expect(() => parseTokenFromRedirect(`${REDIRECT}#token_type=Bearer`)).toThrow(/No access token/);
  });
});
