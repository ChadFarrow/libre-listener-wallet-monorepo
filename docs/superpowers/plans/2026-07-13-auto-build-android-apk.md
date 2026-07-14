# Auto-build signed Android APK on push — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every master push that changes the app, CI builds a signed release APK and publishes it as a rolling `android-latest` GitHub Release.

**Architecture:** One committed, idempotent `packages/android-app/scripts/prepare-android.sh` reproduces the manual README wiring (Capacitor deps → PWA build → `cap add` → copy native Kotlin → patch Gradle/manifest/MainActivity → icons). A GitHub Actions workflow runs it on `ubuntu-latest`, injects the release keystore from secrets, `assembleRelease`, and publishes. The fragile file-patching lives in small sourced shell functions that are unit-tested against fixtures (grep-guarded + fail-loud + idempotent).

**Tech Stack:** Bash, Capacitor 7 CLI, Gradle, GitHub Actions, pnpm, `@capacitor/assets`.

## Global Constraints

- App id / package: `com.v4vmusic.librelistener`. Native package dir: `android/app/src/main/java/com/v4vmusic/librelistener/`.
- PWA build MUST use the override: `VITE_LSPS1_MOCK_URL= pnpm --filter @libre/wallet-pwa build`.
- Capacitor pinned to **7.4.3** for core/cli/android/share/filesystem (reproducible generated tree).
- JDK **21** (Capacitor 7 compiles `--release 21`).
- Kotlin Gradle plugin **2.0.21**; `androidx.documentfile:documentfile:1.0.1`.
- Adaptive-icon background color: `#17913F`.
- Native source of truth: `packages/android-app/native/{ForegroundService.kt,LibreForegroundServicePlugin.kt,WebViewResidency.kt,LibreBackupStoragePlugin.kt,AndroidManifest.snippet.xml}`.
- **No committed churn:** Capacitor deps + the `android/` tree exist only at build time; never commit them. `android/` and `keystore.properties` are already gitignored — verify, don't re-add.
- Every patch function MUST be idempotent (re-runnable on the Mac over an existing `android/`) and MUST `exit 1` with a clear message if its anchor is missing (never silently skip).
- Signing secrets (user adds once): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- Rolling release tag: `android-latest`; fixed asset name: `libre-listener-wallet.apk`.
- Commit style: end messages with the repo's `Co-Authored-By:` + `Claude-Session:` trailers. Never push in a task; pushing is a manual step after the plan.

## File Structure

- Create `packages/android-app/scripts/prepare-android.sh` — orchestrator + sourced patch functions. Guarded so sourcing it (for tests) does NOT run `main`.
- Create `packages/android-app/scripts/prepare-android.test.sh` — plain-bash unit tests for the patch functions against fixtures.
- Create `.github/workflows/build-android-apk.yml` — the CI workflow.
- Modify `packages/android-app/README.md` — replace the manual runbook with the script + document the workflow/secrets/download link.
- Modify `packages/android-app/package.json` — add a `prepare:android` script alias.

**Sourcing guard** (top-of-file convention every task relies on): the script ends with
```bash
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
```
so `source prepare-android.sh` in the test file loads the functions without executing `main`.

---

### Task 1: Script skeleton + Kotlin-enable patch (`ensure_kotlin_gradle`)

**Files:**
- Create: `packages/android-app/scripts/prepare-android.sh`
- Create: `packages/android-app/scripts/prepare-android.test.sh`

**Interfaces:**
- Produces: `ensure_kotlin_gradle <android_dir>` — idempotently adds the Kotlin Gradle classpath to `<android_dir>/build.gradle` and `apply plugin: 'org.jetbrains.kotlin.android'` to `<android_dir>/app/build.gradle`. Exits 1 if either anchor is absent.

- [ ] **Step 1: Write the failing test**

Create `packages/android-app/scripts/prepare-android.test.sh`:
```bash
#!/usr/bin/env bash
# Unit tests for prepare-android.sh patch functions. Plain bash, no framework.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/prepare-android.sh"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
assert_contains() { # file needle msg
  if ! grep -qF "$2" "$1"; then echo "FAIL: $3 (missing: $2)"; fail=1; fi
}
assert_count() { # file needle n msg
  local c; c="$(grep -cF "$2" "$1")"
  if [ "$c" != "$3" ]; then echo "FAIL: $4 (found $c of '$2', want $3)"; fail=1; fi
}

# --- ensure_kotlin_gradle ---
mk_kotlin_fixture() {
  mkdir -p "$1/app"
  cat > "$1/build.gradle" <<'EOF'
buildscript {
    dependencies {
        classpath 'com.android.tools.build:gradle:8.7.2'
    }
}
EOF
  cat > "$1/app/build.gradle" <<'EOF'
apply plugin: 'com.android.application'
android {
}
EOF
}
d="$TMP/kt"; mk_kotlin_fixture "$d"
ensure_kotlin_gradle "$d"
assert_contains "$d/build.gradle" "org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21" "kotlin classpath added"
assert_contains "$d/app/build.gradle" "apply plugin: 'org.jetbrains.kotlin.android'" "kotlin plugin applied"
# idempotency: run again, no duplicates
ensure_kotlin_gradle "$d"
assert_count "$d/build.gradle" "kotlin-gradle-plugin:2.0.21" 1 "kotlin classpath not duplicated"
assert_count "$d/app/build.gradle" "org.jetbrains.kotlin.android" 1 "kotlin plugin not duplicated"

if [ "$fail" = 0 ]; then echo "ALL TESTS PASSED"; else echo "TESTS FAILED"; exit 1; fi
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: FAIL — `prepare-android.sh` does not exist / `ensure_kotlin_gradle: command not found`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/android-app/scripts/prepare-android.sh`:
```bash
#!/usr/bin/env bash
# Turn the committed android-app sources into a ready-to-assembleRelease android/ tree.
# Idempotent: safe to re-run on the Mac over an existing android/ tree. Shared by CI and local builds.
set -euo pipefail

die() { echo "prepare-android: ERROR: $*" >&2; exit 1; }
log() { echo "prepare-android: $*"; }

# Add the Kotlin Gradle plugin so the native .kt sources compile (Capacitor's template is Java-only).
ensure_kotlin_gradle() {
  local android="$1"
  local proj="$android/build.gradle" app="$android/app/build.gradle"
  [ -f "$proj" ] || die "missing $proj"
  [ -f "$app" ]  || die "missing $app"

  if ! grep -qF "kotlin-gradle-plugin:2.0.21" "$proj"; then
    grep -qE '^\s*dependencies\s*\{' "$proj" || die "no buildscript dependencies{} in $proj"
    # insert after the first 'dependencies {' line
    awk '
      !done && /dependencies[[:space:]]*\{/ {
        print; print "        classpath '\''org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21'\''"; done=1; next
      } { print }
    ' "$proj" > "$proj.tmp" && mv "$proj.tmp" "$proj"
  fi

  if ! grep -qF "org.jetbrains.kotlin.android" "$app"; then
    grep -qF "apply plugin: 'com.android.application'" "$app" || die "no com.android.application apply in $app"
    awk '
      !done && /apply plugin: '\''com.android.application'\''/ {
        print; print "apply plugin: '\''org.jetbrains.kotlin.android'\''"; done=1; next
      } { print }
    ' "$app" > "$app.tmp" && mv "$app.tmp" "$app"
  fi
  log "kotlin gradle wiring ok"
}

main() {
  die "main not implemented yet"  # replaced in Task 6
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add packages/android-app/scripts/prepare-android.sh packages/android-app/scripts/prepare-android.test.sh
git commit -m "feat(android): prepare-android.sh skeleton + Kotlin gradle patch (tested)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0181hjeMiV5pC68XAuXTxDTW"
```

---

### Task 2: App-Gradle deps + signing config (`ensure_app_deps_signing`)

**Files:**
- Modify: `packages/android-app/scripts/prepare-android.sh`
- Modify: `packages/android-app/scripts/prepare-android.test.sh`

**Interfaces:**
- Consumes: nothing from prior tasks (operates on `<android_dir>` directly).
- Produces: `ensure_app_deps_signing <android_dir>` — adds `androidx.documentfile` to `app/build.gradle` dependencies, injects a `signingConfigs { release { … } }` block that reads `keystore.properties` if present, and sets `buildTypes.release.signingConfig` conditionally. Idempotent; exits 1 if `android {` or `dependencies {` anchors missing.

- [ ] **Step 1: Write the failing test**

Append to `prepare-android.test.sh` (before the final pass/fail check):
```bash
# --- ensure_app_deps_signing ---
mk_app_fixture() {
  mkdir -p "$1/app"
  cat > "$1/app/build.gradle" <<'EOF'
apply plugin: 'com.android.application'
android {
    namespace "com.v4vmusic.librelistener"
    defaultConfig {
        applicationId "com.v4vmusic.librelistener"
        versionCode 1
        versionName "1.0"
    }
    buildTypes {
        release {
            minifyEnabled false
        }
    }
}
dependencies {
    implementation project(':capacitor-android')
}
EOF
}
d="$TMP/app"; mk_app_fixture "$d"
ensure_app_deps_signing "$d"
a="$d/app/build.gradle"
assert_contains "$a" "androidx.documentfile:documentfile:1.0.1" "documentfile dep added"
assert_contains "$a" "signingConfigs {" "signingConfigs block added"
assert_contains "$a" "keystore.properties" "reads keystore.properties"
assert_contains "$a" "signingConfig" "release signingConfig set"
ensure_app_deps_signing "$d"
assert_count "$a" "androidx.documentfile:documentfile:1.0.1" 1 "documentfile not duplicated"
assert_count "$a" "signingConfigs {" 1 "signingConfigs not duplicated"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: FAIL — `ensure_app_deps_signing: command not found`.

- [ ] **Step 3: Write minimal implementation**

Insert this function into `prepare-android.sh` after `ensure_kotlin_gradle`:
```bash
# Add the SAF dep + a keystore.properties-driven release signing config to app/build.gradle.
ensure_app_deps_signing() {
  local android="$1" app="$1/app/build.gradle"
  [ -f "$app" ] || die "missing $app"
  grep -qE '^\s*android\s*\{' "$app" || die "no android{} in $app"
  grep -qE '^\s*dependencies\s*\{' "$app" || die "no dependencies{} in $app"

  # 1) documentfile dependency
  if ! grep -qF "androidx.documentfile:documentfile:1.0.1" "$app"; then
    awk '
      !done && /^[[:space:]]*dependencies[[:space:]]*\{/ {
        print; print "    implementation \"androidx.documentfile:documentfile:1.0.1\""; done=1; next
      } { print }
    ' "$app" > "$app.tmp" && mv "$app.tmp" "$app"
  fi

  # 2) signingConfigs block as the first thing inside android { }
  if ! grep -qF "signingConfigs {" "$app"; then
    awk '
      !done && /^[[:space:]]*android[[:space:]]*\{/ {
        print
        print "    signingConfigs {"
        print "        release {"
        print "            def kf = rootProject.file(\"keystore.properties\")"
        print "            if (kf.exists()) {"
        print "                def kp = new Properties(); kf.withInputStream { kp.load(it) }"
        print "                storeFile file(kp[\"storeFile\"])"
        print "                storePassword kp[\"storePassword\"]"
        print "                keyAlias kp[\"keyAlias\"]"
        print "                keyPassword kp[\"keyPassword\"]"
        print "            }"
        print "        }"
        print "    }"
        done=1; next
      } { print }
    ' "$app" > "$app.tmp" && mv "$app.tmp" "$app"
  fi

  # 3) apply the release signing config inside buildTypes.release (only if keystore present at build)
  if ! grep -qF "signingConfig rootProject.file" "$app"; then
    awk '
      !done && /^[[:space:]]*release[[:space:]]*\{/ && inbuild {
        print
        print "            signingConfig rootProject.file(\"keystore.properties\").exists() ? signingConfigs.release : null"
        done=1; next
      }
      /buildTypes[[:space:]]*\{/ { inbuild=1 }
      { print }
    ' "$app" > "$app.tmp" && mv "$app.tmp" "$app"
  fi
  log "app gradle deps + signing ok"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add packages/android-app/scripts/prepare-android.sh packages/android-app/scripts/prepare-android.test.sh
git commit -m "feat(android): app gradle SAF dep + keystore signing config (tested)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0181hjeMiV5pC68XAuXTxDTW"
```

---

### Task 3: Version stamping (`stamp_version`)

**Files:**
- Modify: `packages/android-app/scripts/prepare-android.sh`
- Modify: `packages/android-app/scripts/prepare-android.test.sh`

**Interfaces:**
- Produces: `stamp_version <android_dir> <code> <name>` — sets `versionCode <code>` and `versionName "<name>"` in `app/build.gradle` `defaultConfig`. Idempotent (replaces existing values). Exits 1 if the fields are absent.

- [ ] **Step 1: Write the failing test**

Append to `prepare-android.test.sh`:
```bash
# --- stamp_version ---
d="$TMP/ver"; mk_app_fixture "$d"
stamp_version "$d" 42 "0.0.42"
v="$d/app/build.gradle"
assert_contains "$v" "versionCode 42" "versionCode set"
assert_contains "$v" 'versionName "0.0.42"' "versionName set"
stamp_version "$d" 43 "0.0.43"
assert_contains "$v" "versionCode 43" "versionCode replaced"
assert_count "$v" "versionCode " 1 "single versionCode line"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: FAIL — `stamp_version: command not found`.

- [ ] **Step 3: Write minimal implementation**

Add to `prepare-android.sh`:
```bash
# Set versionCode/versionName in app/build.gradle defaultConfig.
stamp_version() {
  local app="$1/app/build.gradle" code="$2" name="$3"
  [ -f "$app" ] || die "missing $app"
  grep -qE 'versionCode ' "$app" || die "no versionCode in $app"
  grep -qE 'versionName ' "$app" || die "no versionName in $app"
  sed -E -i.bak "s/versionCode [0-9]+/versionCode ${code}/" "$app"
  sed -E -i.bak "s/versionName \"[^\"]*\"/versionName \"${name}\"/" "$app"
  rm -f "$app.bak"
  log "version stamped ${code} / ${name}"
}
```
Note: on GNU sed `-i.bak` works; on BSD/macOS sed `-i.bak` also works (both accept a suffix arg). This form is portable across the Linux runner and the Mac.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add packages/android-app/scripts/prepare-android.sh packages/android-app/scripts/prepare-android.test.sh
git commit -m "feat(android): stamp_version for build.gradle (tested)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0181hjeMiV5pC68XAuXTxDTW"
```

---

### Task 4: Manifest merge (`merge_manifest`)

**Files:**
- Modify: `packages/android-app/scripts/prepare-android.sh`
- Modify: `packages/android-app/scripts/prepare-android.test.sh`

**Interfaces:**
- Produces: `merge_manifest <snippet_file> <manifest_file>` — inserts the snippet's `<uses-permission>`/`<uses-feature>` elements just before `</manifest>`, and its `<service>` element just before `</application>`. Idempotent (keyed on each element's `android:name`). Exits 1 if `</application>` or `</manifest>` missing.

**Implementation note (validated against the real snippet):** the real `native/AndroidManifest.snippet.xml` contains **XML comments** AND a **multi-line `<service …/>`** element. A naive line-by-line merge scatters comment lines into the manifest and splits the multi-line service across insertion points. So the function extracts elements **structurally**, not line-by-line: `grep -oE` pulls the single-line `<uses-*/>` elements (ignoring comment text automatically), and an `awk` flattens the `<service … />` block (from `<service` to the first `/>`) into one line. This exact approach was run against the real snippet and produces 6 permissions + one flattened service inside `<application>`, idempotent, with zero comment leakage.

- [ ] **Step 1: Write the failing test**

Append to `prepare-android.test.sh`. The fixture mirrors the REAL snippet's shape — comments + a multi-line `<service>` — with a `LEAK-CANARY` comment that must not appear in the output:
```bash
# --- merge_manifest ---
d="$TMP/man"; mkdir -p "$d"
cat > "$d/snippet.xml" <<'EOF'
<!-- LEAK-CANARY: this comment must NOT end up in the manifest -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
<!-- 2) Service: place inside <application>. -->
<service
    android:name=".ForegroundService"
    android:exported="false"
    android:foregroundServiceType="dataSync" />
EOF
cat > "$d/AndroidManifest.xml" <<'EOF'
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Libre">
        <activity android:name=".MainActivity" />
    </application>
</manifest>
EOF
merge_manifest "$d/snippet.xml" "$d/AndroidManifest.xml"
m="$d/AndroidManifest.xml"
assert_contains "$m" "android.permission.FOREGROUND_SERVICE" "permission merged"
assert_contains "$m" ".ForegroundService" "service merged"
assert_contains "$m" "foregroundServiceType=" "service attrs preserved (flattened to one line)"
assert_count "$m" "LEAK-CANARY" 0 "snippet comment did NOT leak into the manifest"
# placement: service inside <application>; permission before </manifest>
python3 - "$m" <<'PY' || { echo "FAIL: element placement"; fail=1; }
import sys; t=open(sys.argv[1]).read()
assert t.index(".ForegroundService") < t.index("</application>")
assert t.index('permission.FOREGROUND_SERVICE"') < t.index("</manifest>")
PY
merge_manifest "$d/snippet.xml" "$d/AndroidManifest.xml"
assert_count "$m" 'permission.FOREGROUND_SERVICE"' 1 "permission not duplicated"
assert_count "$m" ".ForegroundService" 1 "service not duplicated"
# fail-loud on missing anchor
bad="$TMP/man-bad"; mkdir -p "$bad"
printf '<manifest></manifest>\n' > "$bad/AndroidManifest.xml"   # no </application>
if ( merge_manifest "$d/snippet.xml" "$bad/AndroidManifest.xml" ) >/dev/null 2>&1; then
  echo "FAIL: merge_manifest should die when </application> is missing"; fail=1
fi
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: FAIL — `merge_manifest: command not found`.

- [ ] **Step 3: Write minimal implementation**

Add to `prepare-android.sh` (this exact code was validated against the real snippet — see the implementation note):
```bash
# Merge native/AndroidManifest.snippet.xml into the generated manifest. The snippet has XML comments
# and a MULTI-LINE <service> element, so extract elements STRUCTURALLY (not line-by-line): grep -oE
# the single-line <uses-*/> elements (comment text is ignored automatically), and awk-flatten the
# <service …/> block. <uses-*> → before </manifest>; <service> → before </application>. Idempotent,
# keyed on android:name.
merge_manifest() {
  local snippet="$1" manifest="$2"
  [ -f "$snippet" ]  || die "missing $snippet"
  [ -f "$manifest" ] || die "missing $manifest"
  grep -qF "</application>" "$manifest" || die "no </application> in $manifest"
  grep -qF "</manifest>"   "$manifest" || die "no </manifest> in $manifest"

  local el key
  # 1) permissions/features — each is a single self-closed element.
  while IFS= read -r el; do
    [ -z "$el" ] && continue
    key="$(printf '%s' "$el" | grep -oE 'android:name="[^"]*"' | head -1)"
    if [ -n "$key" ] && grep -qF "$key" "$manifest"; then continue; fi
    awk -v ins="    $el" '/<\/manifest>/ && !d {print ins; d=1} {print}' "$manifest" > "$manifest.tmp" \
      && mv "$manifest.tmp" "$manifest"
  done < <(grep -oE '<uses-(permission|feature)[^>]*/>' "$snippet")

  # 2) service — flatten the possibly multi-line <service …/> block to one line.
  local service
  service="$(awk '/<service/{c=1} c{buf=buf" "$0} c&&/\/>/{print buf; exit}' "$snippet" \
    | tr -s ' \t' ' ' | sed -E 's/^ //')"
  if [ -n "$service" ]; then
    key="$(printf '%s' "$service" | grep -oE 'android:name="[^"]*"' | head -1)"
    if ! { [ -n "$key" ] && grep -qF "$key" "$manifest"; }; then
      awk -v ins="        $service" '/<\/application>/ && !d {print ins; d=1} {print}' "$manifest" > "$manifest.tmp" \
        && mv "$manifest.tmp" "$manifest"
    fi
  fi
  log "manifest merged"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add packages/android-app/scripts/prepare-android.sh packages/android-app/scripts/prepare-android.test.sh
git commit -m "feat(android): merge_manifest permissions+service (tested)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0181hjeMiV5pC68XAuXTxDTW"
```

---

### Task 5: Plugin registration (`register_plugins`)

**Files:**
- Modify: `packages/android-app/scripts/prepare-android.sh`
- Modify: `packages/android-app/scripts/prepare-android.test.sh`

**Interfaces:**
- Produces: `register_plugins <mainactivity_java>` — inserts `registerPlugin(LibreForegroundServicePlugin.class);` and `registerPlugin(LibreBackupStoragePlugin.class);` into `onCreate` before `super.onCreate`. The plugins live in the same package as `MainActivity`, so no plugin imports are needed. Idempotent; `die`s if there is no `class MainActivity`. If the generated `MainActivity` has no `onCreate` override, it synthesizes one using the fully-qualified `android.os.Bundle` (no import edit → portable).

**Implementation note (validated in bash against 3 forms):** Capacitor 7 commonly generates the empty body on ONE line — `public class MainActivity extends BridgeActivity {}` — not a lone `}` on its own line. The implementation therefore normalizes a same-line `{}` body to multi-line first, then injects, so it handles all three real forms: `{}` one-line, `{`…`}` multi-line, and an existing `onCreate` (inject before `super.onCreate`). This exact code + a two-form test were run and verified.

- [ ] **Step 1: Write the failing test**

Append to `prepare-android.test.sh`. Cover BOTH empty-body forms (`{}` one-line — the likely real Capacitor output — and the multi-line `}`):
```bash
# --- register_plugins ---
rp_check() { # <file> <label>
  local j="$1" label="$2"
  register_plugins "$j"; register_plugins "$j"   # run twice → idempotent
  assert_contains "$j" "registerPlugin(LibreForegroundServicePlugin.class)" "$label: fg plugin registered"
  assert_contains "$j" "registerPlugin(LibreBackupStoragePlugin.class)" "$label: backup plugin registered"
  assert_contains "$j" "super.onCreate(savedInstanceState)" "$label: onCreate synthesized"
  assert_count "$j" "registerPlugin(LibreForegroundServicePlugin.class)" 1 "$label: fg not duplicated"
  assert_count "$j" "super.onCreate" 1 "$label: single super.onCreate"
}
d="$TMP/act"; mkdir -p "$d"
# Form A: empty body on ONE line (common Capacitor 7 output)
printf 'package com.v4vmusic.librelistener;\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {}\n' > "$d/A.java"
rp_check "$d/A.java" "oneline"
# Form B: empty body, closing brace on its own line
printf 'package com.v4vmusic.librelistener;\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {\n}\n' > "$d/B.java"
rp_check "$d/B.java" "multiline"
# fail-loud when there is no MainActivity class
printf 'package x;\n' > "$d/none.java"
if ( register_plugins "$d/none.java" ) >/dev/null 2>&1; then
  echo "FAIL: register_plugins should die without a MainActivity class"; fail=1
fi
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: FAIL — `register_plugins: command not found`.

- [ ] **Step 3: Write minimal implementation**

Add to `prepare-android.sh` (this exact code was validated in bash against all three MainActivity forms):
```bash
# Register the two native plugins in MainActivity.onCreate. Handles all Capacitor MainActivity shapes:
# an existing onCreate (inject before super.onCreate), a multi-line empty body, and — the common
# Capacitor 7 output — an empty body on ONE line ("... {}"), which is normalized to multi-line first.
# Synthesized onCreate uses fully-qualified android.os.Bundle so no import edit is needed (portable).
register_plugins() {
  local j="$1"
  [ -f "$j" ] || die "missing $j"
  if grep -qF "registerPlugin(LibreForegroundServicePlugin.class)" "$j"; then
    log "plugins already registered"; return
  fi
  grep -qF "class MainActivity" "$j" || die "no MainActivity class in $j"

  if grep -qF "super.onCreate" "$j"; then
    # existing onCreate: insert registerPlugin lines before super.onCreate
    awk '
      /super\.onCreate/ && !d {
        print "        registerPlugin(LibreForegroundServicePlugin.class);"
        print "        registerPlugin(LibreBackupStoragePlugin.class);"
        d=1
      } { print }
    ' "$j" > "$j.tmp" && mv "$j.tmp" "$j"
  else
    # no onCreate: normalize a same-line "... {}" body to multi-line, then inject onCreate before the
    # class's final lone "}".
    awk '
      { lines[NR]=$0 }
      END {
        emptyline=0
        for (i=1;i<=NR;i++)
          if (lines[i] ~ /class MainActivity[^{]*\{\}[[:space:]]*$/) { sub(/\{\}[[:space:]]*$/,"{",lines[i]); emptyline=i }
        n=0
        for (i=1;i<=NR;i++) { n++; arr[n]=lines[i]; if (i==emptyline) { n++; arr[n]="}" } }
        last=0; for (i=1;i<=n;i++) if (arr[i] ~ /^}[[:space:]]*$/) last=i
        if (last==0) { print "register_plugins: no injection point in " FILENAME > "/dev/stderr"; exit 3 }
        for (i=1;i<=n;i++) {
          if (i==last) {
            print "    @Override"
            print "    public void onCreate(android.os.Bundle savedInstanceState) {"
            print "        registerPlugin(LibreForegroundServicePlugin.class);"
            print "        registerPlugin(LibreBackupStoragePlugin.class);"
            print "        super.onCreate(savedInstanceState);"
            print "    }"
          }
          print arr[i]
        }
      }
    ' "$j" > "$j.tmp" || die "register_plugins: could not inject onCreate into $j"
    mv "$j.tmp" "$j"
  fi
  log "plugins registered"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add packages/android-app/scripts/prepare-android.sh packages/android-app/scripts/prepare-android.test.sh
git commit -m "feat(android): register_plugins in MainActivity (tested)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0181hjeMiV5pC68XAuXTxDTW"
```

---

### Task 6: Orchestration `main` + `copy_native` + icons

**Files:**
- Modify: `packages/android-app/scripts/prepare-android.sh`
- Modify: `packages/android-app/package.json` (add `prepare:android` script)

**Interfaces:**
- Consumes: all patch functions from Tasks 1–5.
- Produces: `main` — full pipeline. Env inputs: `ANDROID_VERSION_CODE` (default 1), `ANDROID_VERSION_NAME` (default `0.0.0-dev`), `CAP_VERSION` (default `7.4.3`). Assumes CWD = repo root.

**Note:** `copy_native` and the deps/build/`cap add`/icon steps depend on external tools (pnpm, cap, npx) and a real generated tree, so they aren't unit-tested here — they're exercised end-to-end by the workflow's first `workflow_dispatch` run (see Task 7 + the rollout). Keep them thin and fail-loud.

- [ ] **Step 1: Add `copy_native` and real `main`**

Replace the placeholder `main` in `prepare-android.sh` with:
```bash
# Repo-root-relative paths.
PKG="packages/android-app"
ANDROID="$PKG/android"
NATIVE="$PKG/native"
PKG_JAVA="$ANDROID/app/src/main/java/com/v4vmusic/librelistener"

copy_native() {
  [ -d "$NATIVE" ] || die "missing $NATIVE"
  mkdir -p "$PKG_JAVA"
  local f
  for f in ForegroundService.kt LibreForegroundServicePlugin.kt WebViewResidency.kt LibreBackupStoragePlugin.kt; do
    [ -f "$NATIVE/$f" ] || die "missing $NATIVE/$f"
    cp "$NATIVE/$f" "$PKG_JAVA/$f"
  done
  log "native kotlin copied"
}

set_icon_background() {
  local f="$ANDROID/app/src/main/res/values/ic_launcher_background.xml"
  [ -f "$f" ] || { log "no ic_launcher_background.xml (skipping color set)"; return; }
  sed -E -i.bak 's|(<color name="ic_launcher_background">)[^<]*(</color>)|\1#17913F\2|' "$f"
  rm -f "$f.bak"
}

main() {
  local cap="${CAP_VERSION:-7.4.3}"
  local vcode="${ANDROID_VERSION_CODE:-1}"
  local vname="${ANDROID_VERSION_NAME:-0.0.0-dev}"
  [ -f "pnpm-workspace.yaml" ] || die "run from the repo root"

  log "installing Capacitor deps (not committed)"
  pnpm --filter @libre/android-app add \
    "@capacitor/core@$cap" "@capacitor/cli@$cap" "@capacitor/android@$cap" \
    "@capacitor/share@$cap" "@capacitor/filesystem@$cap"

  log "building wallet-pwa (mock LSP override enforced)"
  VITE_LSPS1_MOCK_URL= pnpm --filter @libre/wallet-pwa build

  if [ -d "$ANDROID" ]; then
    log "android/ exists → cap sync"
    pnpm --filter @libre/android-app exec cap sync android
  else
    log "generating android/ → cap add"
    pnpm --filter @libre/android-app exec cap add android
  fi

  copy_native
  ensure_kotlin_gradle "$ANDROID"
  ensure_app_deps_signing "$ANDROID"
  stamp_version "$ANDROID" "$vcode" "$vname"
  merge_manifest "$NATIVE/AndroidManifest.snippet.xml" "$ANDROID/app/src/main/AndroidManifest.xml"
  register_plugins "$PKG_JAVA/MainActivity.java"

  log "generating launcher icons"
  ( cd "$PKG" && npx --yes @capacitor/assets generate --android ) \
    || log "icon generation skipped (assets tool unavailable — keeps template placeholder)"
  set_icon_background

  log "DONE — android/ ready. Build: (cd $ANDROID && ./gradlew assembleRelease)"
}
```

- [ ] **Step 2: Verify the test suite still passes (functions unchanged)**

Run: `bash packages/android-app/scripts/prepare-android.test.sh`
Expected: `ALL TESTS PASSED` (unit tests cover the patch fns; `main` is not invoked when sourced).

- [ ] **Step 3: Shellcheck the script**

Run: `shellcheck packages/android-app/scripts/prepare-android.sh || true`
Expected: no errors (warnings acceptable). If `shellcheck` is not installed, skip.

- [ ] **Step 4: Add the package.json alias**

In `packages/android-app/package.json` `scripts`, add:
```json
"prepare:android": "bash scripts/prepare-android.sh"
```

- [ ] **Step 5: Commit**

```bash
git add packages/android-app/scripts/prepare-android.sh packages/android-app/package.json
git commit -m "feat(android): prepare-android.sh main pipeline + copy_native + icons

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0181hjeMiV5pC68XAuXTxDTW"
```

---

### Task 7: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/build-android-apk.yml`

**Interfaces:**
- Consumes: `prepare-android.sh` (Task 6), the 4 signing secrets.
- Produces: a rolling `android-latest` release with `libre-listener-wallet.apk`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/build-android-apk.yml`:
```yaml
name: Build Android APK

on:
  push:
    branches: [master]
    paths:
      - "packages/wallet-pwa/**"
      - "packages/shared/**"
      - "packages/libre-listener-wallet/**"
      - "packages/android-app/**"
      - ".github/workflows/build-android-apk.yml"
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: build-android-apk
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Unit-test the prepare script
        run: bash packages/android-app/scripts/prepare-android.test.sh

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"

      - name: Install workspace (frozen)
        run: pnpm install --frozen-lockfile

      - name: Prepare android/ tree
        env:
          ANDROID_VERSION_CODE: ${{ github.run_number }}
          ANDROID_VERSION_NAME: 0.0.${{ github.run_number }}
        run: bash packages/android-app/scripts/prepare-android.sh

      - name: Write keystore + properties from secrets
        env:
          KS_B64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
          KS_PW: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          KEY_PW: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: |
          if [ -z "$KS_B64" ]; then
            echo "::error::ANDROID_KEYSTORE_* secrets are not set — add them (see packages/android-app/README.md). Refusing to publish an unsigned APK."
            exit 1
          fi
          KS="$RUNNER_TEMP/release.keystore"
          echo "$KS_B64" | base64 -d > "$KS"
          cat > packages/android-app/android/keystore.properties <<EOF
          storeFile=$KS
          storePassword=$KS_PW
          keyAlias=$KEY_ALIAS
          keyPassword=$KEY_PW
          EOF

      - name: Assemble release APK
        run: |
          cd packages/android-app/android
          ./gradlew assembleRelease --no-daemon

      - name: Verify signer
        run: |
          APK=packages/android-app/android/app/build/outputs/apk/release/app-release.apk
          BT=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
          "$BT/apksigner" verify --print-certs "$APK"
          cp "$APK" libre-listener-wallet.apk

      - name: Publish rolling android-latest release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: android-latest
          name: Android APK (latest)
          body: |
            Rolling signed APK from the newest master build.
            Version 0.0.${{ github.run_number }} — commit ${{ github.sha }}.
            Install over an existing app with `adb install -r` (same signing key preserves the wallet).
          files: libre-listener-wallet.apk
          fail_on_unmatched_files: true
```

- [ ] **Step 2: Validate YAML locally**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build-android-apk.yml')); print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-android-apk.yml
git commit -m "ci(android): auto-build signed APK on master push → android-latest release

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0181hjeMiV5pC68XAuXTxDTW"
```

---

### Task 8: README update

**Files:**
- Modify: `packages/android-app/README.md`

- [ ] **Step 1: Replace the manual one-time-setup + signed-release runbook with the script**

Edit `packages/android-app/README.md`:
- In "One-time setup" / "Build → install → iterate": replace the hand-wiring steps (copy native, enable Kotlin, merge manifest, edit MainActivity, generate icons) with:
  ```bash
  # from the repo root — reproduces the full android/ wiring idempotently:
  pnpm --filter @libre/android-app prepare:android
  # then build:
  cd packages/android-app/android
  JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew assembleRelease
  ```
  Keep the JDK-21 / keystore.properties / device-permission notes; delete the numbered manual wiring list (now the script's job) but leave a one-line pointer: "The exact wiring lives in `scripts/prepare-android.sh` (unit-tested in `prepare-android.test.sh`)."
- Add a new "## Auto-build (CI)" section:
  ```markdown
  ## Auto-build (CI)

  `.github/workflows/build-android-apk.yml` builds a **signed** APK on every master push touching
  `wallet-pwa` / `shared` / `libre-listener-wallet` / `android-app`, and publishes it to the rolling
  **`android-latest`** GitHub Release. Stable download:
  `https://github.com/ChadFarrow/libre-listener-wallet-monorepo/releases/download/android-latest/libre-listener-wallet.apk`

  Install/update in place (same key preserves the wallet): `adb install -r libre-listener-wallet.apk`.

  **One-time secrets** (repo → Settings → Secrets and variables → Actions), from your EXISTING release
  keystore so CI builds install over your current app:
  - `ANDROID_KEYSTORE_BASE64` = `base64 -i ~/libre-android-release.keystore | pbcopy`
  - `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`

  Until the secrets exist the workflow fails fast (it refuses to publish an unsigned APK).
  ```
- Update the status note at the top (lines ~9–13): the "can't be built in CI" claim is now false — replace with "Builds in CI on ubuntu-latest via `scripts/prepare-android.sh`."

- [ ] **Step 2: Commit**

```bash
git add packages/android-app/README.md
git commit -m "docs(android): document prepare:android script + CI auto-build + secrets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0181hjeMiV5pC68XAuXTxDTW"
```

---

## Rollout (manual, after the plan lands)

1. **Push** the branch/commits to master (or merge). The `paths` filter will trigger the workflow (the workflow file itself is in the filter), OR run it via **Actions → Build Android APK → Run workflow** (`workflow_dispatch`).
2. **First run before secrets** = expected FAIL at the "Write keystore" step (fails fast, no unsigned publish). This still proves `prepare-android.sh` + `cap add` + `assembleRelease`-up-to-signing work in CI. Watch the "Prepare android/ tree" + "Unit-test the prepare script" steps go green.
3. **If prepare/build steps fail on a patch anchor** (Capacitor 7.4.3 template drift), read the failing `die` message, adjust the anchor/regex in the offending patch function + its fixture test, commit, re-run. This is the one iteration the plan expects.
4. **Add the 4 secrets** from the existing release keystore (README command). Re-run the workflow.
5. **Verify:** download `libre-listener-wallet.apk` from the `android-latest` release; `apksigner verify --print-certs` shows YOUR release cert; `adb install -r` over the current app succeeds (signature match → wallet preserved).

## Self-Review notes

- **Spec coverage:** trigger+paths (Task 7), prepare script all 9 wiring steps (Tasks 1–6), signing via secrets (Tasks 2,7), versioning (Task 3,7), rolling-latest delivery (Task 7), README/secrets docs (Task 8), no-committed-churn (Task 6 installs ephemerally; `android/` gitignored), mock-LSP override (Task 6 `main`). Covered.
- **Idempotency** (spec invariant): every patch fn has a same-run-twice assertion (Tasks 1–5).
- **Fail-loud** (spec invariant): every patch fn `die`s on a missing anchor.
- **Known execution risk:** the fixtures approximate the Capacitor 7.4.3 generated files; the real anchors are validated by the first CI run (rollout step 2–3). The grep-guarded/fail-loud design makes drift a loud, localized fix, not a silent wrong build.
```
