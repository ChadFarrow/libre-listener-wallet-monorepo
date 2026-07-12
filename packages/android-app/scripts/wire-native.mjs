// Wire the CANONICAL native sources (packages/android-app/native/) into the FRESHLY GENERATED,
// gitignored `android/` Capacitor project, exactly as the README runbook describes — but scripted so
// CI (and a local build) can do it deterministically instead of by hand. Idempotent: safe to re-run.
//
// Steps (mirrors packages/android-app/README.md "wire the ... plugin into the generated project"):
//   1. copy native/*.kt into the app package dir
//   2. enable Kotlin (root build.gradle classpath + app build.gradle plugin + jvmTarget)
//   3. add the androidx.documentfile dep the backup plugin needs
//   4. write MainActivity.java that registers all three plugins
//   5. merge the permissions + <service> from AndroidManifest.snippet.xml
//   6. stamp versionCode / versionName from env (VERSION_CODE / VERSION_NAME), when provided
//
// Run from anywhere: `node packages/android-app/scripts/wire-native.mjs` AFTER `cap add android`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, ".."); // packages/android-app
const nativeDir = path.join(appDir, "native");
const androidDir = path.join(appDir, "android");
const pkgPath = "com/v4vmusic/librelistener";
const javaPkgDir = path.join(androidDir, "app/src/main/java", pkgPath);

const KOTLIN_VERSION = "2.0.21";
const JVM_TARGET = "21";
const DOCUMENTFILE = "androidx.documentfile:documentfile:1.0.1";

function must(cond, msg) {
  if (!cond) {
    console.error(`[wire-native] ERROR: ${msg}`);
    process.exit(1);
  }
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}
function write(p, s) {
  fs.writeFileSync(p, s);
  console.log(`[wire-native] wrote ${path.relative(appDir, p)}`);
}

must(fs.existsSync(androidDir), `generated android/ not found at ${androidDir} — run \`cap add android\` first`);
must(fs.existsSync(nativeDir), `native/ sources not found at ${nativeDir}`);

// 1) Copy the canonical Kotlin plugin sources into the generated app package dir.
fs.mkdirSync(javaPkgDir, { recursive: true });
for (const f of fs.readdirSync(nativeDir).filter((n) => n.endsWith(".kt"))) {
  fs.copyFileSync(path.join(nativeDir, f), path.join(javaPkgDir, f));
  console.log(`[wire-native] copied native/${f}`);
}

// 2a) Root build.gradle: add the Kotlin Gradle plugin to the buildscript classpath.
const rootGradlePath = path.join(androidDir, "build.gradle");
let rootGradle = read(rootGradlePath);
if (!rootGradle.includes("kotlin-gradle-plugin")) {
  const m = rootGradle.match(/(\n(\s*)classpath ['"]com\.android\.tools\.build:gradle[^\n]*\n)/);
  must(m, "could not find the com.android.tools.build:gradle classpath line in android/build.gradle");
  const indent = m[2];
  rootGradle = rootGradle.replace(
    m[1],
    `${m[1]}${indent}classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}'\n`,
  );
  write(rootGradlePath, rootGradle);
} else {
  console.log("[wire-native] root build.gradle already has the Kotlin plugin — skipping");
}

// 2b + 3) App build.gradle: apply the Kotlin plugin at the top, and append a merge-block for
// jvmTarget + the documentfile dependency (a trailing `android {}` / `dependencies {}` block merges
// into the existing extension — far more robust than surgically editing the generated blocks).
const appGradlePath = path.join(androidDir, "app/build.gradle");
let appGradle = read(appGradlePath);
if (!appGradle.includes("org.jetbrains.kotlin.android")) {
  const applyLine = "apply plugin: 'com.android.application'";
  must(appGradle.includes(applyLine), "could not find the com.android.application apply line in app/build.gradle");
  appGradle = appGradle.replace(applyLine, `${applyLine}\napply plugin: 'org.jetbrains.kotlin.android'`);
}
// versionCode / versionName stamping (env-driven; only when provided).
if (process.env.VERSION_CODE) {
  appGradle = appGradle.replace(/versionCode\s+\d+/, `versionCode ${process.env.VERSION_CODE}`);
}
if (process.env.VERSION_NAME) {
  appGradle = appGradle.replace(/versionName\s+"[^"]*"/, `versionName "${process.env.VERSION_NAME}"`);
}
const MERGE_MARKER = "// --- Libre CI additions (wire-native.mjs) ---";
if (!appGradle.includes(MERGE_MARKER)) {
  appGradle += `
${MERGE_MARKER}
android {
    kotlinOptions { jvmTarget = "${JVM_TARGET}" }
}
dependencies {
    implementation "${DOCUMENTFILE}"
}
`;
}
write(appGradlePath, appGradle);

// 4) MainActivity.java — register all three custom plugins before super.onCreate.
const mainActivityPath = path.join(javaPkgDir, "MainActivity.java");
write(
  mainActivityPath,
  `package com.v4vmusic.librelistener;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LibreForegroundServicePlugin.class);
        registerPlugin(LibreBackupStoragePlugin.class);
        registerPlugin(LibreDiagnosticsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`,
);

// 5) AndroidManifest.xml — merge the permissions + the <service> from the snippet.
const manifestPath = path.join(androidDir, "app/src/main/AndroidManifest.xml");
let manifest = read(manifestPath);
const permissions = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
  "android.permission.WAKE_LOCK",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "android.permission.SYSTEM_ALERT_WINDOW",
];
const permLines = permissions
  .filter((p) => !manifest.includes(`android:name="${p}"`))
  .map((p) => `    <uses-permission android:name="${p}" />`)
  .join("\n");
if (permLines) {
  // Insert just before the <application> tag.
  must(manifest.includes("<application"), "no <application> tag in AndroidManifest.xml");
  manifest = manifest.replace(/(\s*)<application/, `\n${permLines}\n$1<application`);
}
let appInserts = "";
if (!manifest.includes(".ForegroundService")) {
  appInserts +=
    '        <service\n' +
    '            android:name=".ForegroundService"\n' +
    '            android:exported="false"\n' +
    '            android:foregroundServiceType="dataSync" />\n';
}
// Dedicated FileProvider for the Diagnostics share sheet (ACTION_SEND needs a content:// URI). Its own
// authority so it never collides with Capacitor's built-in "${applicationId}.fileprovider".
if (!manifest.includes(".diagfileprovider")) {
  appInserts +=
    '        <provider\n' +
    '            android:name="androidx.core.content.FileProvider"\n' +
    '            android:authorities="${applicationId}.diagfileprovider"\n' +
    '            android:exported="false"\n' +
    '            android:grantUriPermissions="true">\n' +
    '            <meta-data\n' +
    '                android:name="android.support.FILE_PROVIDER_PATHS"\n' +
    '                android:resource="@xml/diag_file_paths" />\n' +
    '        </provider>\n';
}
if (appInserts) {
  manifest = manifest.replace(/(\s*)<\/application>/, `\n${appInserts}$1</application>`);
}
write(manifestPath, manifest);

// The FileProvider's path map: expose cacheDir/diagnostics/ (where LibreDiagnosticsPlugin writes).
const xmlDir = path.join(androidDir, "app/src/main/res/xml");
fs.mkdirSync(xmlDir, { recursive: true });
write(
  path.join(xmlDir, "diag_file_paths.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<paths>
    <cache-path name="diagnostics" path="diagnostics/" />
</paths>
`,
);

console.log("[wire-native] done.");
