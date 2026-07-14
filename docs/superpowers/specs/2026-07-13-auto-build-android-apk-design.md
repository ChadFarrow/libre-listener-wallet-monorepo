# Auto-build signed Android APK on push — design

**Date:** 2026-07-13
**Status:** Approved (design), pending implementation plan
**Author:** Chad + Claude

## Problem

New APKs are built by hand on the maintainer's Mac following a long prose runbook
(`packages/android-app/README.md`). Every `wallet-pwa` / SDK / native fix therefore reaches the phone
only when someone remembers to run the manual `cap add` → copy-native → patch-gradle → merge-manifest →
patch-MainActivity → generate-icons → `assembleRelease` sequence. The user wants a fresh, installable
APK produced automatically whenever they push a change that affects the app, with no local build step.

The README claims the APK "can't be built in CI." That is not a hard limitation — it reflects that the
`android/` project, the Capacitor dependencies, and the native Kotlin wiring are all currently **manual
Mac steps**. Each is scriptable and runs fine on a Linux runner with the Android SDK.

## Goals

- On every push to `master` that changes what the app runs, produce a **signed release APK**.
- The APK is signed with the **same key as the current installed app**, so it installs as an in-place
  update (`adb install -r`) without wiping the wallet.
- Deliver it at a **stable download URL** so the maintainer always grabs the newest build from one link.
- No committed dependency / lockfile churn; no secrets in the repo; the mock-LSP override stays enforced.
- Collapse the manual README runbook into **one script** shared by CI and the Mac (kills prose drift).

## Non-goals

- Play Store / F-Droid distribution (rolling sideload only).
- Tagged/versioned releases (rolling `android-latest` only for now; can add later).
- Changing any runtime behavior of the app, the native plugins, or the storage contract.
- iOS (unaddressed; separate track).

## Architecture

Two committed artifacts:

### A. `packages/android-app/scripts/prepare-android.sh`

Idempotent script that turns the committed sources (`native/*`, `capacitor.config.ts`, the `wallet-pwa`
build) into a ready-to-`assembleRelease` `android/` tree. Reproduces the README's "One-time setup" +
"Signed release build" wiring, in order:

1. Install Capacitor deps into `@libre/android-app` (NOT frozen; pinned versions):
   `@capacitor/core @capacitor/cli @capacitor/android @capacitor/share @capacitor/filesystem` at a
   pinned 7.x. This mutates `package.json`/lockfile in the working tree only — never committed.
2. Build the PWA the APK wraps, with the mandatory override:
   `VITE_LSPS1_MOCK_URL= pnpm --filter @libre/wallet-pwa build`.
3. `pnpm --filter @libre/android-app exec cap add android` (generates the gitignored `android/` tree).
   If `android/` already exists (local re-run), `cap sync android` instead.
4. Copy `native/ForegroundService.kt`, `native/LibreForegroundServicePlugin.kt`,
   `native/WebViewResidency.kt`, `native/LibreBackupStoragePlugin.kt` into
   `android/app/src/main/java/com/v4vmusic/librelistener/`.
5. Patch Gradle:
   - `android/build.gradle`: add `classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21'` to
     `buildscript` dependencies (skip if present).
   - `android/app/build.gradle`: add `apply plugin: 'org.jetbrains.kotlin.android'`; add
     `implementation "androidx.documentfile:documentfile:1.0.1"`; inject the **release `signingConfigs`
     block** reading `keystore.properties` (guarded: absent file → unsigned, so the script is safe with
     no secrets locally); set `buildTypes.release.signingConfig`.
6. Merge `native/AndroidManifest.snippet.xml` into `android/app/src/main/AndroidManifest.xml`
   (permissions into `<manifest>`, `<service>` into `<application>`), idempotently.
7. Patch `MainActivity.java` to `registerPlugin(LibreForegroundServicePlugin.class)` +
   `registerPlugin(LibreBackupStoragePlugin.class)` in `onCreate` before `super.onCreate` (skip if
   present).
8. Stamp version: `versionCode` + `versionName` in `android/app/build.gradle` from env
   (`ANDROID_VERSION_CODE` / `ANDROID_VERSION_NAME`), defaulting to `1` / `0.0.0-dev` for local runs.
9. Generate launcher icons from `assets/logo.png` via `npx @capacitor/assets generate --android`, then
   set `android/app/src/main/res/values/ic_launcher_background.xml` to `#17913F`.

All file patches are **idempotent** (detect-then-insert), so a local Mac re-run against an existing
`android/` tree is safe. The script does NOT write `keystore.properties` — that is the caller's job (CI
writes it from secrets; the Mac user already has it).

**Idempotency test seam:** each patch step is a small function that greps for its own marker before
editing, so running the script twice produces no second insertion. This is the primary correctness risk
and gets explicit coverage (a `bats`-style or plain shell assertion run twice in CI's own job, or at
minimum a dry-run + re-run in the workflow).

### B. `.github/workflows/build-android-apk.yml`

Mirrors `release-extension-latest.yml`.

- **Triggers:** `push` to `master` with `paths: [packages/wallet-pwa/**, packages/shared/**,
  packages/libre-listener-wallet/**, packages/android-app/**]`; plus `workflow_dispatch`.
- **Permissions:** `contents: write` (to publish the release). Least privilege otherwise.
- **Runner:** `ubuntu-latest`.
- **Steps:**
  1. checkout, `actions/setup-node` + pnpm, `actions/setup-java@v4` with `temurin` JDK 21, Android SDK
     is preinstalled on the runner (`ANDROID_HOME`).
  2. `pnpm install --frozen-lockfile` (installs the committed workspace; Capacitor deps are added later
     by the prepare script, non-frozen).
  3. Decode keystore to `$RUNNER_TEMP/release.keystore`
     (`echo "$ANDROID_KEYSTORE_BASE64" | base64 -d`).
  4. Run `prepare-android.sh` with `ANDROID_VERSION_CODE=${{ github.run_number }}`,
     `ANDROID_VERSION_NAME=0.0.${{ github.run_number }}` (this generates the `android/` tree).
  5. Write `packages/android-app/android/keystore.properties` from the decoded keystore path + the
     password/alias secrets (done in the workflow, AFTER prepare's `cap add`, so `prepare-android.sh`
     stays secret-agnostic — see "Open decision").
  6. `cd packages/android-app/android && ./gradlew assembleRelease` (JDK 21 via `JAVA_HOME`).
  7. Verify signer: `apksigner verify --print-certs app-release.apk`.
  8. Rename to `libre-listener-wallet.apk`; publish/replace the rolling **`android-latest`** release
     (`softprops/action-gh-release` or `gh release`), asset overwrite on, so
     `…/releases/latest/download/libre-listener-wallet.apk` always serves the newest build.

- **Secrets (user adds once):** `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

## Open decision (resolve in plan)

Where `keystore.properties` is written: **workflow step after prepare** (keeps `prepare-android.sh`
secret-agnostic and identical for local runs, where the Mac already has its own `keystore.properties`).
Chosen: workflow writes it. The prepare script's Gradle signing block just reads the file if present.

## Versioning

- `versionCode`: `github.run_number` — monotonically increasing integer, satisfies Android's update rule.
- `versionName`: `0.0.<run_number>` — human-visible, traceable to a workflow run. (A future enhancement
  can derive semver from a tag, like the extension; out of scope now.)

## Delivery

Rolling GitHub Release `android-latest`, single fixed asset `libre-listener-wallet.apk`. Stable link:
`https://github.com/ChadFarrow/libre-listener-wallet-monorepo/releases/latest/download/libre-listener-wallet.apk`
— assuming `android-latest` is the most recent release; if other rolling releases exist, target the
release by tag explicitly in the download link. (Extension uses the same `/latest/download/` pattern.)

## Guardrails / invariants preserved

- **No committed churn:** Capacitor deps + `android/` tree exist only in the runner; nothing is
  committed back. CI's `--frozen-lockfile` install runs BEFORE the non-frozen Capacitor add.
- **Mock-LSP override enforced:** the PWA build inside prepare always uses `VITE_LSPS1_MOCK_URL=`.
- **Secret hygiene:** keystore exists only decoded inside the runner tmp; never logged; `.gitignore`
  already covers `android/` and `keystore.properties`.
- **Storage contract untouched:** no wallet on-disk format changes; this is build tooling only.
- **Fund-safety untouched:** no runtime code changes.

## Risks

- **Patch fragility:** the Gradle/manifest/MainActivity patches target files generated by `cap add`,
  whose exact layout can shift with Capacitor versions. Mitigation: pin Capacitor to a specific 7.x;
  make each patch grep-guarded and fail loudly if its anchor is missing (don't silently skip).
- **First green run needs the secrets:** until the user adds the 4 secrets, `assembleRelease` produces
  an unsigned APK (guarded signing block) and the signer-verify step fails. The workflow should fail
  clearly ("add ANDROID_KEYSTORE_* secrets") rather than publish an unsigned APK.
- **Runner Android SDK license/components:** may need `sdkmanager` to accept licenses / install a
  build-tools version for `apksigner`. Handle in the workflow (accept licenses, ensure build-tools).

## Rollout

1. Land the script + workflow (no secrets yet) — a `workflow_dispatch` run proves prepare + build up to
   the signing gate.
2. User adds the 4 secrets + confirms the base64 of the existing release keystore.
3. Re-run: first signed `android-latest` APK. User `adb install -r` over the current app (same key →
   wallet preserved) to confirm the signature matches.
4. Update `packages/android-app/README.md`: replace the manual runbook with "run `prepare-android.sh`";
   document the workflow + the download link + the secrets.
