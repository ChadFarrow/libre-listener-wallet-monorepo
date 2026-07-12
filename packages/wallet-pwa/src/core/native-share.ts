// Native "save a text file" seam for the Android APK (see packages/android-app
// LibreDiagnosticsPlugin.kt). A Capacitor WebView cannot export a file the way a browser can:
// `navigator.share({ files })` isn't supported and a blob `<a download>` click is a silent no-op (the
// WebView has no download handler for blob: URLs). So the diagnostics export — which works in desktop
// and mobile *browsers* via Web Share / blob download — did nothing in the APK. This routes it through
// a native Storage-Access-Framework "Save document" dialog (ACTION_CREATE_DOCUMENT) instead, the same
// SAF pattern the backup plugin uses, so the user can save the file locally or to any installed
// provider (Files, Drive, …). Dependency-free (no @capacitor/core import) — probes the runtime globals
// Capacitor injects — so the plain PWA build is unaffected.

import { isNativeApp } from "./native-bridge";

const PLUGIN_NAME = "LibreDiagnostics";

interface DiagnosticsSharePlugin {
  // Opens the OS "Save document" dialog and writes `contents` to the chosen location. Rejects with a
  // message containing "cancel" if the user dismisses the dialog.
  saveText(opts: { name: string; contents: string; mimeType?: string }): Promise<void>;
}

function plugin(): DiagnosticsSharePlugin | null {
  const p = (globalThis as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
    ?.Plugins?.[PLUGIN_NAME] as Partial<DiagnosticsSharePlugin> | undefined;
  return p && typeof p.saveText === "function" ? (p as DiagnosticsSharePlugin) : null;
}

// True only inside the native wrapper AND when the diagnostics-share plugin is registered. False in a
// plain PWA, or in a wrapper build predating the plugin (the caller then falls back to clipboard).
export function nativeShareAvailable(): boolean {
  return isNativeApp() && plugin() !== null;
}

// Save a text file via the native SAF dialog. Returns true when the plugin handled it (saved), false
// when the plugin isn't present so the caller can fall back. A user cancel is re-thrown as an
// AbortError so callers can treat it identically to the Web Share cancel (silent, not an error).
export async function nativeSaveText(name: string, contents: string, mimeType = "text/plain"): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  try {
    await p.saveText({ name, contents, mimeType });
    return true;
  } catch (e) {
    const msg = (e as Error)?.message || "";
    if (/cancel/i.test(msg)) {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    }
    throw e;
  }
}
