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
