// Native share-sheet seam for the Android APK (see packages/android-app LibreDiagnosticsPlugin.kt). A
// Capacitor WebView cannot export a file the way a browser can: `navigator.share({ files })` isn't
// supported and a blob `<a download>` click is a silent no-op (the WebView has no download handler for
// blob: URLs). So the diagnostics export — which works in desktop and mobile *browsers* via Web Share /
// blob download — did nothing in the APK. This routes it through the native Android **share sheet**
// (ACTION_SEND), the direct analog of the iOS share sheet: the user gets the full target list (Nearby
// Share, email, Drive, "Save to Files", …) and picks where the log goes. Dependency-free (no
// @capacitor/core import) — probes the runtime globals Capacitor injects — so the plain PWA build is
// unaffected.

import { isNativeApp } from "./native-bridge";

const PLUGIN_NAME = "LibreDiagnostics";

interface DiagnosticsSharePlugin {
  // Opens the Android system share sheet with `contents` as a text/plain attachment.
  shareText(opts: { name: string; contents: string; mimeType?: string }): Promise<void>;
}

function plugin(): DiagnosticsSharePlugin | null {
  const p = (globalThis as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
    ?.Plugins?.[PLUGIN_NAME] as Partial<DiagnosticsSharePlugin> | undefined;
  return p && typeof p.shareText === "function" ? (p as DiagnosticsSharePlugin) : null;
}

// True only inside the native wrapper AND when the diagnostics-share plugin is registered. False in a
// plain PWA, or in a wrapper build predating the plugin (the caller then falls back to clipboard).
export function nativeShareAvailable(): boolean {
  return isNativeApp() && plugin() !== null;
}

// Share a text file via the native Android share sheet. Returns true when the plugin handled it, false
// when the plugin isn't present so the caller can fall back.
export async function nativeShareText(name: string, contents: string, mimeType = "text/plain"): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  await p.shareText({ name, contents, mimeType });
  return true;
}
