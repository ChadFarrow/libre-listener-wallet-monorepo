# @libre/android-app — native Android wrapper (Capacitor)

Wraps the existing **`@libre/wallet-pwa`** build in a native Android app whose **foreground service**
keeps the process — and therefore the in-WebView LDK node + Nostr relay socket — alive in the
background. This is the one thing a browser tab can't do, and it's what lets NWC boosts settle while
the app is backgrounded / the screen is off. Pure AOSP (no Firebase / Google Play Services), so it
works on **GrapheneOS**.

> **Status: APK builds (2026-07-12), on-device behavior unverified.** The full runbook below has been
> executed on the maintainer's Mac and produces a working `app-debug.apk` (plugin classes in the dex,
> service + permissions in the manifest, wallet assets incl. the LDK WASM packaged). It can't be built
> in CI or a headless Linux box. Everything about *runtime* behavior is unverified until the Phase 0
> spike runs on a real GrapheneOS device.

Approved plan & rationale: `Target B` in `ai/reference/this-monorepo/libre-listener-wallet-architecture.md`.
The web-side seam already lives in `packages/wallet-pwa/src/core/native-bridge.ts` (chooses the native
foreground service over the audio keep-alive when running in this wrapper).

---

## Prerequisites (macOS)

- Node + pnpm (repo already uses `pnpm@10`), and the **Android SDK** + platform-tools (Android Studio
  is optional — a plain `~/Library/Android/sdk` + gradle CLI build works fine).
- **JDK 21** (Capacitor 7's Android library compiles with `--release 21`; JDK 17 fails with
  `invalid source release: 21`). `brew install openjdk@21`, then pass it as `JAVA_HOME` (see the build
  step below) — Android Studio users get a bundled JDK and can skip this.
- A **GrapheneOS device** with Developer options → USB debugging on, connected over USB (`adb devices` shows it).

## One-time setup

```bash
# from the repo root
pnpm install

# add Capacitor to THIS package (kept out of the committed lockfile on purpose — added on the Mac).
# NOTE: this rewrites package.json + pnpm-lock.yaml locally — do NOT commit those changes (CI's
# frozen-lockfile install and the no-committed-deps design depend on them staying out).
pnpm --filter @libre/android-app add @capacitor/core @capacitor/cli @capacitor/android

# build the PWA the wrapper will host (produces packages/wallet-pwa/dist).
# The VITE_LSPS1_MOCK_URL= override is MANDATORY (same rule as the Cloudflare deploy): a gitignored
# .env.local sets it for dev, and without the override the dev mock LSP gets baked into the APK.
VITE_LSPS1_MOCK_URL= pnpm --filter @libre/wallet-pwa build

# generate the native android/ project (gitignored)
pnpm --filter @libre/android-app cap:add
```

Then wire the foreground-service plugin into the generated project (the `native/` files are the
canonical source — copy them in):

1. Copy `native/ForegroundService.kt`, `native/LibreForegroundServicePlugin.kt`,
   `native/WebViewResidency.kt`, and `native/LibreBackupStoragePlugin.kt` into
   `android/app/src/main/java/com/v4vmusic/librelistener/` (the package dir already exists — it holds
   the generated `MainActivity.java`). The backup-storage plugin (SAF off-device backup) also needs
   `implementation "androidx.documentfile:documentfile:1.0.1"` added to `android/app/build.gradle`'s
   `dependencies { }`.
2. **Enable Kotlin** — the Capacitor template generates a Java-only project, so the `.kt` sources
   won't compile until you:
   - add `classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21'` to the `buildscript`
     dependencies in `android/build.gradle`, and
   - add `apply plugin: 'org.jetbrains.kotlin.android'` under `apply plugin: 'com.android.application'`
     in `android/app/build.gradle`.
3. Merge `native/AndroidManifest.snippet.xml` into `android/app/src/main/AndroidManifest.xml`
   (permissions inside `<manifest>`, the `<service>` inside `<application>`).
4. In the generated `android/app/src/main/java/.../MainActivity.java` (the template is Java, not
   Kotlin), register the plugin:
   ```java
   public class MainActivity extends BridgeActivity {
       @Override
       public void onCreate(Bundle savedInstanceState) {
           registerPlugin(LibreForegroundServicePlugin.class);
           registerPlugin(LibreBackupStoragePlugin.class);
           super.onCreate(savedInstanceState);
       }
   }
   ```
5. Confirm `applicationId` in `android/app/build.gradle` matches `appId` in `capacitor.config.ts`
   (`com.v4vmusic.librelistener`).
6. **Generate the launcher icon** from the committed source (`assets/logo.png`, the 1024px Libre
   logo-mark) — the Capacitor template ships a generic placeholder, and the generated icons land in
   the gitignored `android/` tree so they must be regenerated on each fresh setup:
   ```bash
   npx @capacitor/assets generate --android
   ```
   Then set the adaptive-icon background to the logo green (it defaults to white, which shows white
   corners under the launcher mask): edit
   `android/app/src/main/res/values/ic_launcher_background.xml` → `<color name="ic_launcher_background">#17913F</color>`.

## Build → install → iterate

> **The APK bundles a FROZEN snapshot of `wallet-pwa/dist` — it does NOT load from `pages.dev`.** A
> Cloudflare/web deploy updates the PWA only; the installed APK keeps running whatever build it was
> compiled with until you rebuild + reinstall (below). So any `wallet-pwa` fix reaches Android only
> on the next APK build.
>
> **Pending fix to pick up on the next build (from PR #73, merged 2026-07-13, PWA-live but NOT yet in
> any APK):** the force-close guard `shouldReconnectPeer` (`wallet-pwa/src/core/auto-start.ts`) — the
> app no longer auto-dials the channel peer when the wallet holds **0 channels**, so a copy that came
> up without its channel state can't reconnect and force-close a live channel. This is platform-
> independent and applies to the APK too; a plain `cap:sync` + rebuild pulls it in (no native code
> change). The other two PR-#73 fixes are PWA/iOS-only: the **backup-ahead start guard** is wired for
> the Google Drive path and deliberately skipped on native (Android backs up via the SAF folder, not
> Drive), and the **iOS Drive redirect** doesn't apply on Android. If you want the backup-ahead guard
> to cover Android too, extend the injected backup fetcher (`main.ts` `setBackupFetcher`, currently
> `!isNativeApp()`) to read the SAF backup via `core/native-backup.ts`.

```bash
# after any change to the web app: rebuild the PWA, then copy it into the native project
VITE_LSPS1_MOCK_URL= pnpm --filter @libre/wallet-pwa build
pnpm --filter @libre/android-app cap:sync

# build the debug APK from the CLI (JDK 21 — see Prerequisites):
cd packages/android-app/android
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew assembleDebug

# ...or open in Android Studio instead: pnpm --filter @libre/android-app open

# sideload it:
adb install -r packages/android-app/android/app/build/outputs/apk/debug/app-debug.apk
```

On first launch, grant the **notification** permission (Android 13+) and the **"draw over other apps"**
permission (Settings → Apps → Libre Listener → Display over other apps — required by the overlay
residency that keeps the node alive in the background; the app also exposes a `requestOverlayPermission`
plugin method to prompt for it). For testing you can grant it via adb:
`adb shell appops set com.v4vmusic.librelistener SYSTEM_ALERT_WINDOW allow`. If boosts still stall in
the background, set the app's battery usage to **Unrestricted**.

## Signed release build

The debug builds above are signed with the shared Android debug key. For a real install, sign with your
OWN key so only you can ship updates. The signing config reads from a **gitignored** `keystore.properties`
(so no secrets in the repo); it's already wired into `android/app/build.gradle` (guarded — absent
properties → the release build is just unsigned).

```bash
# 1) One-time: generate a keystore OUTSIDE the repo. BACK IT UP — lose it and you can never update
#    the installed app (Android requires the same key for updates); you'd have to uninstall (wiping
#    the wallet) and restore from your backup folder.
keytool -genkeypair -v -keystore ~/libre-android-release.keystore -alias librerelease \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Libre Listener Wallet, O=v4vmusic, C=US"

# 2) One-time: write android/keystore.properties (gitignored — under the gitignored android/ tree):
#      storeFile=/absolute/path/to/libre-android-release.keystore
#      storePassword=...
#      keyAlias=librerelease
#      keyPassword=...

# 3) Build the signed release APK:
cd packages/android-app/android
JAVA_HOME=/opt/homebrew/opt/openjdk@21/... ./gradlew assembleRelease
#   → app/build/outputs/apk/release/app-release.apk

# 4) Verify the signer:
~/Library/Android/sdk/build-tools/*/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

**Switching a device from debug- to release-signed is destructive:** the signatures differ, so
`adb install -r` over an existing debug install fails — you must **uninstall first** (which wipes the
wallet), then install the release APK and **restore from your backup folder**. Pick one signing key up
front for any device you care about. Keep the keystore + `keystore.properties` backed up together.

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

## Phase 0 results (2026-07-12, Pixel 6 / Android, debug APK)

First on-device run. The APK built (see the runbook above), installed, and the wallet came up native —
every networking layer verified inside the wrapper along the way:

- **Foreground-service keep-alive works.** Tapping "Keep boosts running in background" started the
  real service (`isForeground=true`, `foregroundServiceType=dataSync`, id 4242), raised the ongoing
  "Libre Listener is running" notification, and held a `PARTIAL_WAKE_LOCK` — all confirmed via
  `dumpsys`. The web→native bridge logged `[KeepAlive/native] foreground service running`, i.e. it
  chose the native path over the audio tone.
- **Transport all works native:** RGS graph sync through the gateway proxy (36.6k channels), ws-bridge
  dial-out + BOLT8 noise handshake to a mainnet peer, and an inbound channel-open handled correctly in
  the **minified** build (`OpenChannelRequest → accept`, the `instanceof` dispatch path that used to
  break in production).

**But the headline finding — R1 is REAL, measured:** with the app backgrounded and the screen off, a
2-second heartbeat injected into the page (via CDP) ran normally for ~1 min while `hidden`, then **all
JS execution froze**. It stayed frozen the entire time the app was backgrounded and resumed the instant
the app returned to foreground:

```
11:49:00  #39  gap=2001ms    vis=hidden    ← last beat while backgrounded
11:56:20  #40  gap=439851ms  vis=visible   ← resumed on foreground: renderer was frozen 7m20s
```

Throughout that 7m20s freeze the foreground service was still up, the wake lock still held, and Android
reported the process `isFrozen=false`. So **process-alive ≠ node-running**: the foreground service
keeps the *process* and its native connections alive (a real gain over the plain PWA, whose tab gets
reaped), but Chromium still suspends the hidden **WebView renderer** — where LDK's event loop and the
relay socket processing actually run. The freeze is a *suspend*, not a kill: JS resumed cleanly on
foreground (network fetch 257 ms), node undamaged.

**Verdict: Arm A fails ("settles only on foreground").** The foreground service alone is necessary but
not sufficient for background settlement. Next per the plan: **Arm B** (force the WebView
resident/visible from the service so Chromium doesn't suspend the renderer) and/or the **R1 mitigation**
(native Nostr relay socket forwarding NIP-47 bytes into the node) — but a native socket only helps if
the renderer can be woken to process the bytes, which points back to Arm B. Full native-LDK is the
heavy fallback.

### Real-app reproduction (same session, real money) — CONFIRMS the maintainer's normal experience

After funding a channel (25k inbound from the maintainer's own node; ~1,646 spendable seeded by a 2k
receive) and pairing an NWC client, a **real V4V boost with splits was sent from stablekraft.app on the
same phone**. Result, verified in logcat and **confirmed by the maintainer as "what has normally been
happening"**:

- While the wallet was **occluded by stablekraft (screen ON)**, the boost's `pay_keysend` split
  requests **queued on the relay unprocessed** — stablekraft reported all splits timed out. No `[NWC]`
  activity in logcat during that window. The foreground service was up the whole time (`isForeground=true`).
- The instant the maintainer **switched back to the wallet**, the renderer thawed and the **entire
  backlog drained in one burst** (`[NWC] response → pay_keysend …`, `PaymentSent … sent!`).

**Two things this sharpens:**
1. The freeze happens on **occlusion, not just screen-off** — the screen was ON, the wallet was merely
   behind stablekraft, and it still froze. So "keep the screen on" is not an escape, and Arm B's
   "keep the WebView visible" cannot apply while another app is genuinely on top. This makes the fix
   harder than a screen-off-only problem.
2. **The native foreground-service wrapper did NOT change the outcome vs. the plain PWA** — same
   queue-and-timeout the maintainer always sees. Target-B-as-scaffolded (foreground service only) does
   not solve the core problem.

**Separate, unrelated issue observed:** of the splits that *did* process (once foreground), most failed
`Failed to find route for payment` — a routing/liquidity problem (single channel to the maintainer's
own node, no network path to most V4V recipients), independent of the background question. Would fail
the same on desktop; fix with better-connected channel liquidity.

### RESOLVED (2026-07-12): overlay residency — background boosts settle occluded, screen on OR off

The **A. renderer-residency** path below was built and it **works**. Two layers in the plugin
(`LibreForegroundServicePlugin.kt` + `WebViewResidency.kt`):

1. Pin the renderer priority to `IMPORTANT` / not-waived-when-hidden (bought ~60s of grace alone).
2. On background, reparent the WebView into a **1x1 always-on-top overlay** (SYSTEM_ALERT_WINDOW) so it
   stays *visible* to Chromium — `visibilityState` never goes hidden, so the freeze timer never starts.
   On foreground, move it back into the activity (use `removeViewImmediate` — plain `removeView` is
   async and leaves the WebView un-re-attached → blank UI; that was the one bug to fix).

**Measured on-device (Pixel 6), all with the app occluded behind another app:**
- **Renderer stays alive indefinitely.** An injected 2s heartbeat held a perfect 2000ms cadence with
  `vis=visible` across **150s occluded (screen on)** AND **120s occluded + screen OFF** — vs. a total
  freeze (≤60s, then dead for 7min) before the fix.
- **Real boosts settle backgrounded.** With **stablekraft.app foreground** (Libre occluded), a real V4V
  boost's `pay_keysend` AND `pay_invoice` splits **processed and settled in real time** (`[NWC] response
  → pay_keysend/pay_invoice` + `PaymentSent … sent!`), while `get_balance`/`get_info` answered live too.
  This is the exact burst that queued-and-timed-out before the fix.
- **UI round-trips cleanly** (occlude → foreground renders normally) and **no crash** from the reparenting.

**Remaining follow-ups (not blockers to the core result):**
- Overlay permission needs an in-app prompt flow (the `requestOverlayPermission` plugin method exists;
  the web side should call it on first background-mode enable). Tested here by granting via adb.
- Battery: **the wake lock was dropped** (2026-07-12) — proven redundant: the 1x1 overlay alone kept
  the node alive across 120s occluded + screen OFF (heartbeat 69/69, zero freezes) with NO
  `PARTIAL_WAKE_LOCK` (`ForegroundService.USE_WAKE_LOCK = false`, easily flipped back). Still worth a
  real all-day drain measurement of the always-resident renderer.
- The "Failed to find route" splits are a **separate** routing/liquidity issue (single channel to one
  peer), not the background problem — fix with better-connected channel liquidity.
- iOS is unaddressed (overlay/foreground-service are Android-only; iOS background NWC needs push).

### Fix direction (superseded by the RESOLVED note above — kept for history)

The requests **queue and drain on foreground rather than being lost**, so the problem is "wake/keep the
renderer running while occluded," not data loss. Candidate fixes, roughly increasing effort/robustness:

- **A. WebView renderer-residency (Arm B, native):** `WebView.setRendererPriorityPolicy(RENDERER_
  PRIORITY_IMPORTANT, waivedWhenNotVisible=false)` + host the node's WebView in the **foreground
  service** attached via `WindowManager` (off-screen), so occlusion of the *activity* doesn't hide the
  *node* WebView. Cheapest to try; **uncertain** it defeats Chromium's page-freeze on occlusion.
- **B. Native relay socket + renderer wake:** a Kotlin WebSocket to the Nostr relay stays alive in the
  service; on an inbound NWC event it must un-freeze the renderer to process — only works if (A)'s
  keep-resident works, so (A) is the prerequisite experiment.
- **C. Native LDK node (`ldk-node` Kotlin):** run the node natively, no WebView freeze at all. Robust,
  but a large rewrite that diverges from the shared TS SDK. This is what native wallets (Phoenix,
  Breez) do, and pairs with push for inbound.
- **Interim that works today:** run the always-on node on a desktop/server/always-on box and use the
  phone apps (incl. this one) as **NWC clients** — sidesteps mobile renderer freezing entirely.

Next experiment: build (A) and re-run the real-app boost test.

**Still open (definitive end-to-end):** the above measures *timer* freeze. The airtight test is an
actual keysend boost sent to the wallet's NWC while backgrounded/screen-off (needs the channel usable
+ an NWC pairing + a second device) — the exact protocol above. Timer-freeze makes the expected result
"doesn't settle until foreground," but run it to close the loop.

---

## Known risks / open validation (see the approved plan for the full list)

- **R1 — hidden-WebView renderer throttling** stalls settlement even with the process alive.
  **CONFIRMED then RESOLVED on-device 2026-07-12** — the 1x1 overlay residency (WebViewResidency.kt)
  keeps the WebView visible so the renderer never freezes; real boosts now settle occluded, screen on
  or off (see the RESOLVED note above).
- **Android 15 dataSync 6h/day cap** on foreground services — may force a `mediaPlayback`-typed service
  (backed by a real MediaSession using the wallet's existing keep-alive tone). Validate in Phase 3/4.
- **Battery optimization** — GrapheneOS may throttle the service; request the ignore-battery-optimization
  exemption and document the per-app toggle.
- **Fund-safety (must not regress):** the service keeps the ONE existing node alive; it must NEVER boot
  a second node, and app/service teardown must call `wallet.stop()` so channel state flushes. Confirm
  a single WebView/node instance and a clean stop on a kill-the-service test.
