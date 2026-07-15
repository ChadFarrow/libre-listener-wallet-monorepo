# Embedding Libre Wallet in your web app (`@libre/wallet-embed`)

A "Connect Libre Wallet" login widget for the maintainer's OWN web apps (pilot:
[boostmebitch](https://boostmebitch.vercel.app)). Tapping Connect signs into Google Drive and
**moves the user's wallet into your page** — the LDK node runs in-page while they use your app
(so iOS backgrounding stops mattering), and your app drives it through a standard
`window.webln` provider. Wallet creation/seed backup live ONLY in the standalone wallet PWA;
the widget is login-only.

> **Trust model — read this first.** Shadow DOM is a style boundary, not a security boundary.
> The embedding page shares the origin (and therefore IndexedDB) with the wallet: a hostile
> host page could read the seed. The approval modal + per-origin daily caps protect against
> host-app *bugs* (a runaway boost loop), not a malicious host. Embed this only on origins the
> wallet's operator controls/trusts. Adversarial third-party embedding needs an
> iframe-on-a-wallet-origin architecture (future work).

## One-time setup per origin (Google Cloud console)

The widget reuses the wallet's existing Google OAuth client ("Libre-wallet web"). For each
embedding origin (e.g. `https://boostmebitch.vercel.app`):

1. Add the **bare origin** (no trailing slash, no path) to **Authorized JavaScript origins**.
2. Add the SAME bare origin to **Authorized redirect URIs** (a different list! The installed-PWA
   redirect flow only checks this one — a mismatch is `Error 400: redirect_uri_mismatch`).
3. While the consent screen is in Testing mode, the Google account must be on the **Test users**
   list.
4. If your app sets a CSP, allow: `script-src https://accounts.google.com`,
   `connect-src https://www.googleapis.com https://oauth2.googleapis.com` + your bridge/esplora/RGS
   endpoints, `frame-src https://accounts.google.com`.

## Install

Not on npm yet — consume the packed tarball from the repo (or the workspace directly):

```bash
pnpm --filter @libre/wallet-embed build && pnpm --filter @libre/wallet-embed pack
# → libre-wallet-embed-0.1.0.tgz  (self-contained: all workspace deps + LDK bundled)
npm i /path/to/libre-wallet-embed-0.1.0.tgz
```

Copy the WASM binary into your static dir (one-line postinstall recommended):

```bash
cp node_modules/@libre/wallet-embed/dist/liblightningjs.wasm public/
```

## Next.js 15 / React 19 (the boostmebitch shape)

```tsx
// components/LibreWallet.tsx
"use client";
import { useEffect, useRef } from "react";

export default function LibreWallet() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let handle: { dispose(): Promise<void> } | undefined;
    void import("@libre/wallet-embed").then(({ mountLibreWallet }) => {
      handle = mountLibreWallet(ref.current!, {
        googleClientId: process.env.NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID!,
        wasmUrl: "/liblightningjs.wasm",
        appName: "boostmebitch",
        installWebln: true, // your existing WebLN rail picks the wallet up unchanged
      });
    });
    return () => void handle?.dispose();
  }, []);
  return <div ref={ref} />;
}
```

The dynamic `import()` inside `useEffect` keeps WASM/IndexedDB strictly client-side; the barrel
is side-effect-free, so even an accidental server import is harmless.

**iOS installed-PWA note:** the Drive login in standalone display mode uses a full-page redirect
that returns to your origin's **`/`** with the token in the URL fragment — mount the widget on
the page served at `/` so the fragment pickup runs on return.

## Script tag (no bundler)

```html
<script src="/libre-wallet.global.js"></script>
<div id="wallet"></div>
<script>
  LibreWallet.mountLibreWallet("#wallet", {
    googleClientId: "…apps.googleusercontent.com",
    wasmUrl: "/liblightningjs.wasm",
    installWebln: true,
  });
</script>
```

## API

```ts
mountLibreWallet(target, {
  googleClientId,           // required — this origin must be registered on the OAuth client
  wasmUrl,                  // required — where you serve liblightningjs.wasm
  network?,                 // default "mainnet"
  appName?,                 // shown in the lease ("active on …") + approval copy
  installWebln?,            // default false; polite install — never clobbers an existing provider
  walletAppUrl?,            // "set up a wallet first" target; defaults to the live wallet PWA
}) → {
  webln,                    // WebLN: enable/getInfo/makeInvoice/sendPayment/keysend
  element,                  // the <libre-wallet> element
  state(), onState(cb),     // roaming view state (running / blocked / moved-away / …)
  dispose(),                // clean handoff: stop node → final Drive flush → release lease
}
```

- Payments run through your OWN UI via WebLN — the widget ships no send/receive screens.
  `keysend` supports `customRecords` (bLIP-10 TLV `7629169` boostagrams as UTF-8 JSON strings).
- Spends are gated by a per-origin **daily cap** the user sets in the first approval; over-cap
  spends re-prompt. Undecodable-amount invoices are refused (fail closed). A `PAYMENT_TIMEOUT`
  is in-flight — rendered pending, charge kept, never blind-retried.
- **Bitcoin Connect:** BC has no runtime connector registration, so the widget integrates via
  `window.webln` (BC's WebLN/Extension option detects it once connected). A native "Libre
  Wallet" connector in the BC modal is a planned upstream contribution.

## The roaming rule (what your users will see)

The wallet lives in ONE place at a time. If it's active on another site, the widget shows
"Your wallet is active on <origin>" with **Move wallet here** — the other tab hands off cleanly
within ~40s. The first login on each new origin asks for the recovery phrase once (the backup
is end-to-end encrypted; Drive never sees keys). Details: `docs/roaming-protocol.md`.
