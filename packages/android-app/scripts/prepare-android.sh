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

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
