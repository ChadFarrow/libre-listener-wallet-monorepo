// iOS Safari / WebKit refuses to satisfy a page NAVIGATION with a Response whose `redirected`
// flag is set — it fails hard with "Response served by service worker has redirections". Cloudflare
// Pages intermittently answers a navigation with a 3xx (trailing-slash / SPA path normalization),
// so the service worker's network-first navigation handler can receive — and, worse, cache — a
// redirected response, which then breaks every launch of an installed home-screen PWA until the
// user deletes and re-adds it.
//
// Rebuilding the response into a fresh Response clears the `redirected` flag (a constructed Response
// is never "redirected"), so the navigation is accepted. Pure + dependency-free so it can be unit
// tested; the SW imports it and applies it before returning/caching any navigation response.
export async function cleanRedirect(res: Response): Promise<Response> {
  if (!res.redirected) return res;
  // arrayBuffer (not blob) as the reconstructed body: it's a universal BodyInit that behaves
  // identically in the real SW and in the jsdom test env (Node's Response doesn't interop with
  // jsdom's Blob). The app shell is a small HTML doc, so buffering it is negligible.
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
