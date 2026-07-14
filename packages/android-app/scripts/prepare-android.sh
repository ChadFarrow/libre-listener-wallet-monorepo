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

main() {
  die "main not implemented yet"  # replaced in Task 6
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
