#!/usr/bin/env bash
# Unit tests for prepare-android.sh patch functions. Plain bash, no framework.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$HERE/prepare-android.sh"
set +e  # the sourced script sets `set -e`; the test harness manages its own error handling

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

# --- ensure_kotlin_gradle: fail-loud on missing anchor ---
bad="$TMP/kt-bad"; mkdir -p "$bad/app"
printf 'buildscript {\n}\n' > "$bad/build.gradle"                       # no dependencies{} anchor
printf "apply plugin: 'com.android.application'\n" > "$bad/app/build.gradle"
if ( ensure_kotlin_gradle "$bad" ) >/dev/null 2>&1; then
  echo "FAIL: ensure_kotlin_gradle should die when buildscript dependencies{} is missing"; fail=1
fi

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

# --- ensure_app_deps_signing: fail-loud on missing anchor ---
bad="$TMP/app-bad"; mkdir -p "$bad/app"
printf 'plugins {}\n' > "$bad/app/build.gradle"   # no android{} / dependencies{}
if ( ensure_app_deps_signing "$bad" ) >/dev/null 2>&1; then
  echo "FAIL: ensure_app_deps_signing should die when android{} is missing"; fail=1
fi

if [ "$fail" = 0 ]; then echo "ALL TESTS PASSED"; else echo "TESTS FAILED"; exit 1; fi
