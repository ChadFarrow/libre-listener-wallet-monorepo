# @libre/wallet-pwa

An installable, mobile-first **Progressive Web App** build of the Libre Listener Wallet. It rebuilds
the polished UX of the `@libre/browser-extension` (create/restore, start/stop, receive, LSPS1
inbound liquidity, NWC, Google Drive + local backup, recovery-phrase/seed reveal, sweep address) as
a standalone web app, hosting the LDK node **directly in one persistent page** — no extension, no
offscreen document, no `chrome.*` APIs.

It shares the same wallet engine (`@libre/listener-wallet`) and the same on-disk storage contract
as the extension and `@libre/example-app`, so **backups interoperate across all three**.

## What it is (and isn't)

- **Is:** a self-contained non-custodial Lightning wallet you can install to your phone/desktop home
  screen. App connectivity is via **NWC (Nostr Wallet Connect)** — pair a Nostr app and it pays
  through this wallet under a per-pairing spending limit.
- **Isn't:** a WebLN provider. A PWA can't inject `window.webln` into other websites the way the
  extension does — that capability is inherently extension-only. NWC is the PWA-native substitute.

## Mobile liveness (read this)

A browser-hosted LDK node **cannot stay alive in the background on mobile.** When the app is
foregrounded it runs fully; when backgrounded/screen-locked the OS freezes it within seconds and the
node goes offline. Funds stay safe (state is persisted; the sweep address recovers a force-close),
but the wallet can only transact while open — **or** in short bursts when the push gateway wakes the
service worker to answer one NWC request (Settings → *Offline wake-ups*). On **iOS**, Web Push fires
only when the PWA is **installed to the home screen** (iOS 16.4+); Android is more reliable.

## Develop

```bash
pnpm --filter @libre/wallet-pwa dev        # http://127.0.0.1:5173
pnpm --filter @libre/wallet-pwa build      # tsc + vite build → dist/ (also runs tsup for the SW + copies WASM)
pnpm --filter @libre/wallet-pwa test       # vitest (incl. the storage-contract guard)
pnpm --filter @libre/wallet-pwa typecheck
```

The Vite `copyLdkWasmPlugin` compiles `src/service-worker.ts` with tsup and copies
`liblightningjs.wasm` into `public/` on every build (both are gitignored — regenerated on build).

## Build-time config (Vite env vars)

Baked at build; all are public (pubkey / URLs / OAuth client id), so repo **Variables** are fine.

| Var | Purpose |
| --- | --- |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth client id for Drive backup (users can override in Settings). |

The mainnet peer / bridge / RGS defaults are baked into `src/core/wallet-config.ts` (the same public
infra the extension ships), so a fresh install works with no configuration.

## Deploy (separate origin)

This app must be deployed to its **own origin**, distinct from the `@libre/example-app` GitHub Pages
site — IndexedDB is scoped by origin (host, not path), so two wallet apps on the same host would
share the same `libre-wallet-<network>` DB and two nodes could race one channel state. Recommended:
**Cloudflare Pages**.

- **Build command:** `pnpm --filter @libre/shared build && pnpm --filter @libre/listener-wallet build && pnpm --filter @libre/wallet-pwa build`
- **Output directory:** `packages/wallet-pwa/dist`
- **Env:** set `VITE_GOOGLE_CLIENT_ID` in the Pages project.

`vite.config.ts` uses `base: "./"`, so the same build works at a domain root or a subpath. Backups
made here restore in the extension / example-app and vice versa.
