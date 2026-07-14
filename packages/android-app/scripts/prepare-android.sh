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

main() {
  die "main not implemented yet"  # replaced in Task 6
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then main "$@"; fi
