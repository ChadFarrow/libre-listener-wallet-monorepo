# @libre/browser-extension

An MV3 browser extension that hosts the Libre Listener Wallet and injects a **WebLN**
(`window.webln`) provider into web pages, so any V4V / Podcasting 2.0 app — or a UI like
[Bitcoin Connect](https://github.com/getAlby/bitcoin-connect) that detects `window.webln` — can
tie into the wallet with zero per-app integration.

Targets **Chrome + Brave** (one Chromium build). Firefox is a planned follow-up (it lacks the
offscreen-documents API, so the node would move to a persistent background page).

## Architecture

```
page app → window.webln (inpage.js, page main world)
         → content-script.js (page origin; stamps the trusted origin)
         → background.js (thin router + per-origin permission gate)
         → offscreen document (long-lived): LibreListenerWallet (LDK+WASM), IndexedDB, WebSocket
popup / options → background → offscreen   (setup, balance, approvals, settings)
```

The LDK node lives in the **offscreen document**, not the background service worker: MV3 kills
the SW after ~30s idle, which would tear down LDK's sync/peer/gossip timers and abort in-flight
payments. The background stays a thin, restartable router that lazily (re)creates the offscreen
document.

- **`src/core/webln-mapping.ts`** — pure WebLN ↔ wallet mapping (unit-tested).
- **`src/core/permission-store.ts`** — per-origin grants + daily spending caps + TOCTOU-safe
  serialization, ported from `NwcManager`'s model (unit-tested).
- **`src/core/bolt11-amount.ts`** — minimal invoice-amount decoder for the cap check (unit-tested).
- **`src/offscreen/`** — the wallet host, settlement tracker, and BOLT11 pay path.
- **`src/background.ts`** — router, offscreen lifecycle, WebLN permission gate.
- **`src/content-script.ts` / `src/inpage/inpage.ts`** — the injected provider + bridge.

## Build

```bash
pnpm install
pnpm --filter @libre/browser-extension build   # → packages/browser-extension/dist/
```

`dist/` is a loadable unpacked extension.

## Load & test manually (Chrome / Brave)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`.
2. Click the toolbar icon → **Create new** → save the shown seed → **Create wallet**.
   (Or **Connection settings** first to set network / esplora / a `wss://` bridge, then create.)
3. Open a test page and drive the provider from the console:
   ```js
   await window.webln.enable();          // → approval popup (set a daily cap)
   await window.webln.getInfo();
   await window.webln.makeInvoice(1000);
   await window.webln.keysend({ destination: "<66-hex pubkey>", amount: 100,
                                customRecords: { 7629169: '{"podcast":"Test","value_msat_total":100000}' } });
   ```
4. Verify the keysend settles and the origin's daily cap decrements in **Connection settings →
   Approved sites**.

> A public `wss://` websockify bridge is still required — a browser/extension node can't open raw
> TCP to a peer's `:9735`. This is unchanged from the PWA.

## Tests

```bash
pnpm --filter @libre/browser-extension test        # unit: mapping, permissions, bolt11
```

Extension end-to-end (load-unpacked + live Lightning) is manual for now.
