// Google OAuth 2.0 (implicit / token) flow for the extension.
//
// The PWA connects Drive via Google Identity Services' remote `gsi/client` script — which an
// MV3 extension's CSP (`script-src 'self'`) forbids loading. So the extension drives OAuth
// itself: it builds the Google authorization URL and hands it to
// `chrome.identity.launchWebAuthFlow`, which opens Google's consent UI and resolves with the
// redirect URL. For the token flow Google returns the access token in that URL's *fragment*.
// The token is short-lived and kept only in memory (never persisted) — same as the PWA.
//
// These are pure helpers (no chrome APIs) so the URL-building and token-parsing are unit-testable.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
// `email` lets us learn the connected account address after consent and reuse it as a
// `login_hint` for a quieter reconnect next session (matches the PWA's behaviour).
export const AUTH_SCOPES = `${DRIVE_SCOPE} email`;

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Build the Google OAuth2 authorization URL for the implicit (token) flow.
 * `redirectUri` must be `chrome.identity.getRedirectURL()` → `https://<ext-id>.chromiumapp.org/`,
 * which the user registers as an authorized redirect URI on their OAuth "Web application" client.
 * `hint` (a remembered account email) pre-selects the account; `prompt: "none"` attempts a silent
 * reconnect against an existing Google session.
 */
export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  opts: { hint?: string; prompt?: string } = {}
): string {
  if (!clientId) throw new Error("Missing Google Client ID");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: AUTH_SCOPES,
    include_granted_scopes: "true",
  });
  if (opts.prompt) params.set("prompt", opts.prompt);
  if (opts.hint) params.set("login_hint", opts.hint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface ParsedToken {
  accessToken: string;
  expiresInSec: number;
}

/**
 * Extract the access token from the redirect URL that `launchWebAuthFlow` resolves with.
 * The token flow returns `#access_token=…&expires_in=…` in the fragment; a denial returns
 * `error=…` (on the query or fragment). Throws on cancellation / error / missing token.
 */
export function parseTokenFromRedirect(redirectUrl: string | undefined): ParsedToken {
  if (!redirectUrl) throw new Error("Google sign-in was cancelled");
  const hashIndex = redirectUrl.indexOf("#");
  const queryIndex = redirectUrl.indexOf("?");
  const fragStr = hashIndex >= 0 ? redirectUrl.slice(hashIndex + 1) : "";
  const queryStr =
    queryIndex >= 0 ? redirectUrl.slice(queryIndex + 1, hashIndex >= 0 ? hashIndex : undefined) : "";
  const frag = new URLSearchParams(fragStr);
  const query = new URLSearchParams(queryStr);
  const error = frag.get("error") || query.get("error");
  if (error) throw new Error(`Google OAuth error: ${error}`);
  const accessToken = frag.get("access_token");
  if (!accessToken) throw new Error("No access token in Google OAuth response");
  const expiresInSec = Number(frag.get("expires_in")) || 3600;
  return { accessToken, expiresInSec };
}
