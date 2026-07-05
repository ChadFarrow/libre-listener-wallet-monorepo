# Could this run as a mobile browser extension?

**Short answer: not as-is, and for most mobile browsers not at all.** The extension is
built on Chrome/Brave *desktop* primitives that either don't exist on mobile or fight the
mobile background lifecycle. The best mobile answer isn't to port the extension — it's to
**run the wallet on your desktop and drive it from your phone over Nostr Wallet Connect
(NWC)**, which already ships in this repo. A native SDK wrapper is the fallback if an
on-device node ever becomes a hard requirement.

## Why the extension itself doesn't port to mobile

The architecture leans on three things mobile browsers don't give you.

### 1. The offscreen document is the whole design — and it's Chrome-desktop-only

The LDK node (WASM + WebSocket + sync/peer/gossip timers) lives in an **offscreen document**,
not the background service worker, because MV3 reaps the SW at ~30s idle (which would tear down
LDK's timers and abort in-flight payments). See `src/manifest.json` (`offscreen` permission) and
`src/offscreen/wallet-host.ts`.

`chrome.offscreen` does not exist on any mainstream mobile browser:

- **Chrome for Android** — no extension support *at all*.
- **Firefox for Android** — supports a limited, curated set of extensions but has **no offscreen
  API** (already noted in this package's README: Firefox "lacks the offscreen-documents API, so
  the node would move to a persistent background page").
- **Safari on iOS** — Safari Web Extensions exist, but there is no offscreen document and
  background pages are non-persistent / event-driven.

### 2. Other Chrome APIs the extension uses are also mobile-hostile

- `chrome.downloads` — the local auto-backup (rolling encrypted file).
- `chrome.identity.launchWebAuthFlow` — Google Drive OAuth (`src/core/drive-oauth.ts`).

Both have poor-to-no support on mobile extension platforms.

### 3. The deeper problem is lifecycle, not just missing APIs

A Lightning node must stay alive to keep its peer connection, service its timers, and settle
in-flight HTLCs — that is the entire reason the node was pushed *out* of the reapable service
worker into the offscreen document. Mobile OSes aggressively suspend and kill background browser
contexts to save battery. Even on a Chromium-on-Android fork that *does* run MV3 extensions, you'd
be hosting a long-lived, fund-holding node in exactly the execution context mobile is most eager
to freeze. That is a fund-safety concern, not merely an inconvenience.

## Feasibility by target

| Target                         | Extensions? | Offscreen API? | Verdict                                                                                         |
| ------------------------------ | ----------- | -------------- | ---------------------------------------------------------------------------------------------- |
| Chrome for Android             | No          | —              | Impossible                                                                                      |
| Firefox for Android            | Limited     | No             | Needs the SW → persistent-background-page rewrite (same work Firefox desktop needs) + fights lifecycle |
| Safari on iOS                  | Yes         | No             | Large rewrite; non-persistent background makes a live node impractical                         |
| Kiwi / Chromium-Android forks  | Sometimes   | Usually no     | Closest technically, but niche/less-maintained browsers + the same lifecycle risk              |

The only path that even resembles the current code is the **"move the node to a persistent
background page"** refactor already on file for Firefox *desktop* — and on mobile that persistent
page still gets killed.

## The path that actually fits mobile: desktop node + NWC on the phone

The strongest mobile answer isn't to run the node on the phone at all — it's to **run the
wallet on your desktop (extension or PWA) and drive it from a mobile app over Nostr Wallet
Connect (NWC / NIP-47).** This is already built end-to-end in this repo:

- **The desktop wallet is the NWC *server*.** `NwcManager` (SDK) creates
  `nostr+walletconnect://` pairings with a per-connection **daily spending cap**, and the
  extension popup / PWA render the pairing QR **on-device** (never a third-party QR service —
  the URI embeds the spend secret). It answers `pay_invoice`, `make_invoice`, `pay_keysend`
  (the V4V boost path), `get_info`, etc.
- **Your phone is just an NWC *client*.** Any NIP-47 app (a nostr client, a podcast app doing
  V4V boosts, Bitcoin Connect) scans the QR and can spend **only up to the cap you set** — the
  seed and node keys never leave the desktop sandbox.
- **Offline desktop still works.** The `@libre/nwc-push-gateway` subscribes to relays and sends
  **Web Push** to wake an offline PWA when an NWC request arrives; `NwcManager` emits NIP-47
  `payment_sent` / `payment_received` notifications so the mobile app reconciles a settlement
  even if its request timed out.

This lines up with the whole design philosophy: the node lives where it has a real lifecycle
(desktop, always-on-ish), and the phone carries a **revocable, capped authority** rather than
funds. It reuses the extension/PWA and gateway exactly as they are — **no mobile-extension or
native-node work required.**

### Fallbacks, if you ever want the node *on* the device

The DI design keeps these open. `CLAUDE.md` describes the SDK as running "inside browser/PWA
sandboxes **(and native mobile wrappers)**"; it takes injected `SecureStorageProvider` /
`WebSocketStreamProvider` / `Logger`, with the note "**Web injects IndexedDB; mobile injects
Keychain.**"

- **A native app (React Native / Capacitor)** embedding `@libre/listener-wallet` with
  Keychain-backed storage and a native socket transport — real background execution / foreground
  service.
- **The existing PWA installed to the home screen** — already runs in the browser sandbox, no
  extension platform needed, accepting mobile's background-suspension caveats.

A mobile *browser extension*, by contrast, would be a large rewrite targeting fringe browsers on
a lifecycle model that is actively unsafe for a node holding funds.

## Recommendation

**Run the wallet on desktop (extension or PWA) and connect your phone over NWC.** It's the
lowest-risk option, it keeps the keys off the phone, and it already ships. Reach for a native
SDK wrapper only if an on-device node becomes a hard requirement — and skip the mobile browser
extension entirely.
