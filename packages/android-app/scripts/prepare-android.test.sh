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

# --- stamp_version ---
d="$TMP/ver"; mk_app_fixture "$d"
stamp_version "$d" 42 "0.0.42"
v="$d/app/build.gradle"
assert_contains "$v" "versionCode 42" "versionCode set"
assert_contains "$v" 'versionName "0.0.42"' "versionName set"
stamp_version "$d" 43 "0.0.43"
assert_contains "$v" "versionCode 43" "versionCode replaced"
assert_count "$v" "versionCode " 1 "single versionCode line"

# --- stamp_version: fail-loud on missing field ---
bad="$TMP/ver-bad"; mkdir -p "$bad/app"
printf 'android {\n  defaultConfig {\n  }\n}\n' > "$bad/app/build.gradle"   # no versionCode/Name
if ( stamp_version "$bad" 1 "0.0.1" ) >/dev/null 2>&1; then
  echo "FAIL: stamp_version should die when versionCode is missing"; fail=1
fi

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

if [ "$fail" = 0 ]; then echo "ALL TESTS PASSED"; else echo "TESTS FAILED"; exit 1; fi
