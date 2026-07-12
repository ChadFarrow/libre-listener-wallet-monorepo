# @libre/android-app — native Android wrapper (Capacitor)

Wraps the existing **`@libre/wallet-pwa`** build in a native Android app whose **foreground service**
keeps the process — and therefore the in-WebView LDK node + Nostr relay socket — alive in the
background. This is the one thing a browser tab can't do, and it's what lets NWC boosts settle while
the app is backgrounded / the screen is off. Pure AOSP (no Firebase / Google Play Services), so it
works on **GrapheneOS**.

> **Status: scaffold — not yet built.** The native project is generated on a machine with the Android
> SDK; it can't be built or tested in CI or a headless Linux box. The steps below run on your Mac with
> a real GrapheneOS device attached. Everything here is unverified until you build it on-device.

Approved plan & rationale: `Target B` in `ai/reference/this-monorepo/libre-listener-wallet-architecture.md`.
The web-side seam already lives in `packages/wallet-pwa/src/core/native-bridge.ts` (chooses the native
foreground service over the audio keep-alive when running in this wrapper).

---

## Prerequisites (macOS)

- Node + pnpm (repo already uses `pnpm@10`), and **Android Studio** with the Android SDK + platform-tools.
- A **GrapheneOS device** with Developer options → USB debugging on, connected over USB (`adb devices` shows it).

## One-time setup

```bash
# from the repo root
pnpm install

# add Capacitor to THIS package (kept out of the committed lockfile on purpose — added on the Mac)
pnpm --filter @libre/android-app add @capacitor/core @capacitor/cli @capacitor/android

# build the PWA the wrapper will host (produces packages/wallet-pwa/dist)
pnpm --filter @libre/wallet-pwa build

# generate the native android/ project (gitignored)
pnpm --filter @libre/android-app cap:add
```

Then wire the foreground-service plugin into the generated project (the `native/` files are the
canonical source — copy them in):

1. Copy `native/ForegroundService.kt` and `native/LibreForegroundServicePlugin.kt` into
   `android/app/src/main/java/com/v4vmusic/librelistener/` (create the package dirs).
2. Merge `native/AndroidManifest.snippet.xml` into `android/app/src/main/AndroidManifest.xml`.
3. In `android/app/src/main/java/.../MainActivity.kt`, register the plugin:
   ```kotlin
   class MainActivity : BridgeActivity() {
       override fun onCreate(savedInstanceState: Bundle?) {
           registerPlugin(LibreForegroundServicePlugin::class.java)
           super.onCreate(savedInstanceState)
       }
   }
   ```
4. Confirm `applicationId` in `android/app/build.gradle` matches `appId` in `capacitor.config.ts`
   (`com.v4vmusic.librelistener`).

## Build → install → iterate

```bash
# after any change to the web app: rebuild the PWA, then copy it into the native project
pnpm --filter @libre/wallet-pwa build
pnpm --filter @libre/android-app cap:sync

# open in Android Studio to build/run, or sideload a debug APK directly:
pnpm --filter @libre/android-app open
# ...or:
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

On first launch, grant the **notification** permission (Android 13+) and, if boosts still stall in the
background, set the app's battery usage to **Unrestricted** (GrapheneOS: Settings → Apps → Libre
Listener → App battery usage).

---

## Phase 0 — the de-risking spike (do this before building anything else out)

**The one question:** with the screen off and the app backgrounded on GrapheneOS, does the existing
node inside the foreground-service-held WebView still receive an inbound NWC request off the relay and
settle the boost?

The wallet already drives the foreground service automatically: turn on **Background mode** in the app
(Developer settings / the home chip). In the native wrapper that toggle starts the foreground service
instead of the audio tone (via `native-bridge.ts`), so the persistent "Libre Listener is running"
notification should appear.

**Protocol**
1. Start the node, connect a channel, turn on Background mode (confirm the ongoing notification).
2. From a **second device** (another wallet / phone), send keysend boosts to this wallet via its NWC
   connection at **t+1, t+5, t+15, t+30, t+60 min**, with the phone's **screen off** the whole time.
3. Export the diagnostics (Developer settings → Diagnostics → share/AirDrop the `.txt`).
4. In the export, compare each boost's send time to its `[NWC] response → pay_keysend` / `pay_invoice`
   line and the `[LDK] ... sent!` line.

**Two arms to compare** (this is the real finding — WebView renderer throttling):
- **Arm A:** default — WebView left to Chromium's background throttling.
- **Arm B:** WebView forcibly kept resident/visible from the service (add a `keepWebViewResident`
  path to the plugin). The delta between A and B tells you whether hidden-WebView throttling is the
  bottleneck.

**Pass:** all boosts settle within a few seconds screen-off in at least one arm → proceed to Phase 1+.
**Fail (settles only on foreground):** apply the R1 mitigation — move ONLY the Nostr relay socket to a
native WebSocket in the plugin and forward raw NIP-47 event bytes into the WebView's (event-driven,
un-throttled) `nwc-manager` handler — before considering a full native-LDK rewrite.

Report the diagnostics back and we iterate on the code from there.

---

## Known risks / open validation (see the approved plan for the full list)

- **R1 — hidden-WebView renderer throttling** stalls settlement even with the process alive. Resolved
  by the two-arm spike above; mitigation is the native relay socket.
- **Android 15 dataSync 6h/day cap** on foreground services — may force a `mediaPlayback`-typed service
  (backed by a real MediaSession using the wallet's existing keep-alive tone). Validate in Phase 3/4.
- **Battery optimization** — GrapheneOS may throttle the service; request the ignore-battery-optimization
  exemption and document the per-app toggle.
- **Fund-safety (must not regress):** the service keeps the ONE existing node alive; it must NEVER boot
  a second node, and app/service teardown must call `wallet.stop()` so channel state flushes. Confirm
  a single WebView/node instance and a clean stop on a kill-the-service test.
