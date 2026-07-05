# Could this run as a mobile browser extension?

**Short answer: not as-is, and for most mobile browsers not at all.** The extension is
built on Chrome/Brave *desktop* primitives that either don't exist on mobile or fight the
mobile background lifecycle. The wallet's real mobile path is a **native wrapper of the SDK**
(already anticipated in the codebase), not a mobile browser extension.

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

## The path that actually fits mobile

The codebase already points here. `CLAUDE.md` describes the SDK as running "inside browser/PWA
sandboxes **(and native mobile wrappers)**," and the dependency-injection design is built for it:
the SDK takes injected `SecureStorageProvider` / `WebSocketStreamProvider` / `Logger`, with the
explicit note "**Web injects IndexedDB; mobile injects Keychain.**"

So the intended mobile story is one of:

- **A native app (React Native / Capacitor)** that embeds `@libre/listener-wallet`, injecting
  Keychain-backed storage and a native socket/WS transport — where the OS provides real background
  execution and a foreground service.
- **The existing PWA installed to the home screen** — it already runs in the browser sandbox with
  no extension platform needed, accepting the same background-suspension caveats.

Either option reuses the SDK as-is. A mobile *browser extension*, by contrast, would be a large
rewrite targeting fringe browsers, on a lifecycle model that is actively unsafe for a node holding
funds.

**Recommendation:** if mobile is a goal, invest in a native SDK wrapper (or lean on the PWA), not
a mobile browser extension.
