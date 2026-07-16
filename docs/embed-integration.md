# Embedding Libre Wallet in your web app (`@libre/wallet-embed`)

A "Connect Libre Wallet" login widget for the maintainer's OWN web apps (pilot:
[boostmebitch](https://boostmebitch.com)). Tapping Connect signs into Google Drive and
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
embedding origin (e.g. `https://boostmebitch.com`):

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

## Theming (match your app, not ours)

Every colour in the card is a `--lw-*` custom property on `:host`. Custom properties inherit
through the shadow boundary, and an outer page's declarations beat `:host`, so you restyle the
whole widget from your own stylesheet — no build flag, no fork:

```css
libre-wallet {
  --lw-bg: #0a0a08;      /* card background   */
  --lw-fg: #fdfaf3;      /* primary text      */
  --lw-line: #1f1d18;    /* borders           */
  --lw-muted: #8a857a;   /* secondary text    */
  --lw-accent: #fae500;  /* buttons, spinner  */
  --lw-accent-2: #fae500;  /* mark gradient, stop 1 */
  --lw-accent-3: #fae500;  /* mark gradient, stop 2 */
  --lw-bad: #d64545;
  --lw-warn: #b98a1c;
}
```

Point them at your own theme variables and the widget follows your light/dark switch for free.
Defaults are the Libre green, so doing nothing keeps the stock look.

**The approval sheet is a top-layer `<dialog>`** — it is deliberately not confined to the card, so
your own modals can never cover it. If it were, a payment prompt opened behind your checkout UI
would be unclickable, and the `sendPayment`/`enable` promise it gates would never settle. Don't
re-parent it, and don't put the widget inside a `display: none` container while a spend is in
flight (the top layer renders nothing under a `display: none` ancestor).

## The roaming rule (what your users will see)

The wallet lives in ONE place at a time. If it's active on another site, the widget shows
"Your wallet is active on <origin>" with **Move wallet here** — the other tab hands off cleanly
within ~40s. The first login on each new origin asks for the recovery phrase once (the backup
is end-to-end encrypted; Drive never sees keys). Details: `docs/roaming-protocol.md`.

## Worked example: boostmebitch (Libre as a wallet-modal rail)

boostmebitch already drives boosts through `window.webln` directly (`lib/v4v/webln.ts`:
`!!window.webln` → `enable()`/`sendPayment()`/`keysend()`), so `installWebln: true` is all it
takes for the existing boost orchestrator to route through Libre — no change to the boost code.
Add Libre as its own option in the wallet picker so there's one place to connect.

**1. Install + ship the wasm** (npm project, Next.js on Vercel):

The release publishes two tarballs. An app with a committed lockfile (Vercel runs `npm ci`)
MUST pin the **immutable per-commit** tarball `libre-wallet-embed-<sha>.tgz` — the rolling
`libre-wallet-embed.tgz` changes bytes on every monorepo build, so a lockfile pinned to it
fails `npm ci` with `EINTEGRITY` on an unrelated deploy. Bump deliberately by repinning to a
newer per-commit tarball. (The rolling URL is fine only for lockfile-free / demo installs.)

```jsonc
// Pin the immutable per-commit tarball, NOT the rolling …/wallet-embed-latest/libre-wallet-embed.tgz:
// npm i https://github.com/ChadFarrow/libre-listener-wallet-monorepo/releases/download/wallet-embed-latest/libre-wallet-embed-<sha>.tgz
"scripts": {
  // Vercel runs postinstall; copies the bundled wasm so it serves at /liblightningjs.wasm
  "postinstall": "node -e \"require('fs').copyFileSync('node_modules/@libre/wallet-embed/dist/liblightningjs.wasm','public/liblightningjs.wasm')\""
}
```
Add `public/liblightningjs.wasm` to `.gitignore` (regenerated on install).

**2. `components/libre-wallet.tsx`** — a client component that mounts the widget and reports its
roaming state to the modal:

```tsx
'use client';
import { useEffect, useRef } from 'react';

export function LibreWallet({
  onConnected,
  onDisconnected,
}: {
  onConnected?: () => void;
  onDisconnected?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let handle: { dispose(): Promise<void>; onState?: (cb: (s: { view: string }) => void) => () => void } | undefined;
    let unsub: (() => void) | undefined;
    void import('@libre/wallet-embed').then(({ mountLibreWallet }) => {
      if (!ref.current) return;
      handle = mountLibreWallet(ref.current, {
        googleClientId: process.env.NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID!,
        wasmUrl: '/liblightningjs.wasm',
        appName: 'boostmebitch',
        installWebln: true,
      });
      unsub = handle.onState?.((s) => {
        if (s.view === 'running') onConnected?.();
        else if (s.view === 'stopped' || s.view === 'moved-away') onDisconnected?.();
      });
    });
    return () => {
      unsub?.();
      void handle?.dispose();
    };
  }, [onConnected, onDisconnected]);
  return <div ref={ref} />;
}
```

**3. `components/wallet-modal.tsx`** — three edits mirroring the existing NWC/WebLN rails:
add `'libre'` to the rail union; add a picker card (`{ rail: 'libre', title: 'Libre Wallet',
description: 'Your roaming Lightning wallet — runs in this app' }`, shown unconditionally, not
gated like the `weblnDetected` WebLN card); and render `{activeRail === 'libre' && <LibreWallet
onConnected={…} onDisconnected={handleDisconnected} />}` in the connecting/connected branch (the
widget draws its own connect/running/disconnect UI — no `mode` prop needed).

Because `installWebln` sets `window.webln`, the modal's separate WebLN card also becomes
"detected" once Libre mounts. Optional: hide the `webln` picker entry while the Libre rail is
connected so users aren't offered two doors to the same wallet.

**4. Config:** set `NEXT_PUBLIC_LIBRE_GOOGLE_CLIENT_ID` (the wallet PWA's OAuth client id) in
Vercel + `.env.local`; register `https://boostmebitch.com` and `http://localhost:3000` in
the OAuth client's JS-origins AND redirect URIs (per the top of this doc); check `next.config.*`
for a CSP and, if present, add the allowances above.
