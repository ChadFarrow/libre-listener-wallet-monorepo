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
