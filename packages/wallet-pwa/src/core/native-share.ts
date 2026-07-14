// Native Android/iOS share sheet for arbitrary text (e.g. a diagnostics export), via the official
// @capacitor/share (+ @capacitor/filesystem) plugins. WHY this exists: the Android System WebView
// does NOT implement the Web Share API at all (navigator.share is undefined) AND silently drops
// `<a download>` blob URLs — so the plain-web diag export produced no file on the APK. This gives the
// real OS chooser (Telegram / Drive / Gmail / …) like the iOS share sheet.
//
// Dependency-free like native-bridge/native-backup: we do NOT statically import the Capacitor
// packages (that would pull them into the plain-PWA bundle). After `cap sync`, the native runtime
// injects them onto `window.Capacitor.Plugins.{Share,Filesystem}`, which we probe at runtime.
//
// We share the log AS A FILE (written to the app cache) rather than inline text, because several
// receiving apps truncate long ACTION_SEND EXTRA_TEXT — a diag ring buffer can be large. If
// Filesystem isn't present we degrade to inline-text sharing. Caveat unchanged from the web path:
// diag text can contain payment preimages — scrub before sharing beyond yourself.

import { isNativeApp } from "./native-bridge";

interface SharePlugin {
  share(opts: {
    title?: string;
    text?: string;
    url?: string;
    files?: string[];
    dialogTitle?: string;
  }): Promise<unknown>;
}

interface FilesystemPlugin {
  writeFile(opts: {
    path: string;
    data: string;
    directory: string;
    encoding: string;
  }): Promise<{ uri: string }>;
}

function plugins(): Record<string, unknown> {
  return (
    (globalThis as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
      ?.Plugins ?? {}
  );
}

function sharePlugin(): SharePlugin | null {
  const p = plugins().Share as Partial<SharePlugin> | undefined;
  return p && typeof p.share === "function" ? (p as SharePlugin) : null;
}

function filesystemPlugin(): FilesystemPlugin | null {
  const p = plugins().Filesystem as Partial<FilesystemPlugin> | undefined;
  return p && typeof p.writeFile === "function" ? (p as FilesystemPlugin) : null;
}

// True only inside the native wrapper AND when the Share plugin is registered.
export function nativeShareAvailable(): boolean {
  return isNativeApp() && sharePlugin() !== null;
}

// Open the OS share sheet for `text`. Shares as a cache file when Filesystem is available (avoids
// EXTRA_TEXT truncation of large logs); otherwise shares the text inline.
export async function nativeShareText(name: string, text: string): Promise<void> {
  const share = sharePlugin();
  if (!share) throw new Error("Sharing is not available.");
  const fs = filesystemPlugin();
  if (fs) {
    const { uri } = await fs.writeFile({
      path: name,
      data: text,
      directory: "CACHE",
      encoding: "utf8",
    });
    await share.share({ title: name, files: [uri], dialogTitle: "Share diagnostics" });
    return;
  }
  await share.share({ title: name, text, dialogTitle: "Share diagnostics" });
}
