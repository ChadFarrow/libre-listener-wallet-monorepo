// Pure helpers for the Google Drive OAuth REDIRECT flow used on installed iOS PWAs (where the GIS
// popup is blocked). This is the OAuth 2.0 implicit grant: a full-page navigation to Google's auth
// endpoint with `response_type=token`, returning the access token in the URL FRAGMENT (which iOS
// preserves across a home-screen app's redirect — unlike the query string). The DOM/navigation +
// token storage live in drive-backup.ts; only the URL string-building lives here so it's testable.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

// Build the Google implicit-grant auth URL. `redirectUri` MUST be registered as an Authorized
// redirect URI on the OAuth client, and `scope` matches the popup flow's scopes. Token comes back
// in the fragment (default response_mode for response_type=token) — no server exchange needed.
export function buildDriveAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "token",
    scope: opts.scope,
    include_granted_scopes: "true",
    state: opts.state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface DriveOAuthReturn {
  accessToken: string;
  state: string | null;
  expiresIn: number | null;
  error: string | null;
}

// Parse the fragment we return to (e.g. "#access_token=ya29...&state=abc&expires_in=3599"). Returns
// null when the fragment isn't an OAuth return at all (so a normal load / a "#demo" hash is ignored),
// and an object (with `error` set) when Google returned an error instead of a token.
export function parseDriveOAuthFragment(hash: string): DriveOAuthReturn | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h) return null;
  const p = new URLSearchParams(h);
  const token = p.get("access_token");
  const error = p.get("error");
  if (!token && !error) return null; // not an OAuth return
  const expiresRaw = p.get("expires_in");
  return {
    accessToken: token ?? "",
    state: p.get("state"),
    expiresIn: expiresRaw ? parseInt(expiresRaw, 10) || null : null,
    error,
  };
}
