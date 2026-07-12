// Native-wrapper seam. When the PWA runs inside the Capacitor Android app (packages/android-app), a
// native FOREGROUND SERVICE keeps the process — and thus the LDK WASM node + Nostr relay socket —
// alive in the background, which a plain browser tab cannot do (it gets frozen within seconds). This
// module is the ONLY place the web app knows it's inside the wrapper; everything else stays
// platform-agnostic. It is dependency-free (no @capacitor/core import) so the plain PWA build is
// unaffected — it probes the globals Capacitor injects at runtime.
//
// Fund-safety note: the foreground service keeps the ONE existing node alive (same guarantee as the
// audio keep-alive), it never boots a second node in the background — the force-close hazard the
// service worker comment warns about is untouched.

import { createKeepAlive, type KeepAlive } from "./keep-alive-audio";

// The wrapper's custom Capacitor plugin name (see packages/android-app native plugin).
const PLUGIN_NAME = "LibreForegroundService";

// Minimal shape of the native foreground-service plugin. Capacitor plugin methods return Promises;
// the KeepAlive interface is sync, so callers fire-and-forget these (a foreground-service start/stop
// is inherently fire-and-forget).
export interface NativeForegroundService {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  // Optional — present in wrapper builds with the overlay-residency plugin. The "draw over other apps"
  // (SYSTEM_ALERT_WINDOW) permission is what lets the node's WebView stay visible (in a 1x1 overlay)
  // while occluded, so the renderer isn't frozen and background boosts settle. Without it the wrapper
  // falls back to a ~60s renderer-priority grace window. Prompt for it when background mode is enabled.
  hasOverlayPermission?(): Promise<{ granted: boolean }>;
  requestOverlayPermission?(): Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

// True when running inside the native wrapper. Honors an explicit flag the wrapper can inject
// (`window.__LIBRE_NATIVE__ = true`) OR Capacitor's own native-platform check — either is sufficient,
// so the app works whether the wrapper sets the flag or we rely on Capacitor's runtime.
export function isNativeApp(): boolean {
  if ((globalThis as unknown as { __LIBRE_NATIVE__?: boolean }).__LIBRE_NATIVE__ === true) return true;
  const cap = capacitor();
  return typeof cap?.isNativePlatform === "function" && cap.isNativePlatform() === true;
}

// Resolve the native foreground-service plugin if the wrapper exposed it, else null (plain PWA, or a
// wrapper build that hasn't registered the plugin yet — we degrade to audio keep-alive).
export function getNativeForegroundService(): NativeForegroundService | null {
  const plugin = capacitor()?.Plugins?.[PLUGIN_NAME] as Partial<NativeForegroundService> | undefined;
  if (plugin && typeof plugin.start === "function" && typeof plugin.stop === "function") {
    return plugin as NativeForegroundService;
  }
  return null;
}

// A KeepAlive backed by the native foreground service. Same interface as the audio keep-alive
// (core/keep-alive-audio.ts) so it's a drop-in swap — bg-mode.ts chip logic and app-context are
// untouched. Differences from audio: unlock() is a no-op (no autoplay gate to satisfy) and
// needsActivation() is always false (native never needs a user tap to hold the page alive).
export function createNativeKeepAlive(service: NativeForegroundService): KeepAlive {
  let active = false;
  // start()/stop() are called on EVERY controller event (main.ts) — state-changed fires ~1/s under
  // payment load — so only cross the plugin bridge (and log) on a real transition, or a streaming
  // session floods the diagnostics ring buffer with keep-alive lines.
  let requested: "start" | "stop" | null = null;
  let loggedFailed = false; // warn once per failure episode, not on every controller-event retry
  return {
    start(): void {
      if (requested === "start") return;
      requested = "start";
      active = true;
      void Promise.resolve(service.start())
        .then(() => {
          if (requested !== "start") return; // stopped meanwhile — don't log a stale "running"
          loggedFailed = false;
          console.log("[KeepAlive/native] foreground service running — node kept alive in the background");
        })
        .catch((e) => {
          // A failed start must not report "background mode on": clear active so the home chip
          // tells the truth, and clear requested so the next controller event retries.
          if (requested === "start") {
            requested = null;
            active = false;
          }
          if (!loggedFailed) {
            loggedFailed = true;
            console.warn("[KeepAlive/native] foreground service start failed:", (e as Error)?.message || e);
          }
        });
    },
    stop(): void {
      // Deliberately NOT gated on `active`: the first stop() (requested === null) still crosses the
      // bridge, so a service orphaned by a START_STICKY restart of a killed process gets cleaned up.
      if (requested === "stop") return;
      requested = "stop";
      active = false;
      void Promise.resolve(service.stop()).catch(() => {
        /* best-effort stop */
      });
      console.log("[KeepAlive/native] foreground service stopped");
    },
    unlock(): void {
      /* no autoplay gate in a native wrapper — nothing to prime */
    },
    isActive(): boolean {
      return active;
    },
    needsActivation(): boolean {
      return false;
    },
  };
}

// Ensure the overlay ("draw over other apps") permission that keeps the node alive while occluded in
// the native wrapper. Called when the user turns ON background mode: if the wrapper exposes the overlay
// plugin methods and the permission isn't granted yet, open the system grant screen once. No-op in a
// plain PWA, or a wrapper build without the overlay methods (it then falls back to the grace window).
export async function ensureOverlayPermission(): Promise<void> {
  if (!isNativeApp()) return;
  const svc = getNativeForegroundService();
  if (!svc?.hasOverlayPermission || !svc.requestOverlayPermission) return;
  try {
    const res = await svc.hasOverlayPermission();
    if (!res?.granted) await svc.requestOverlayPermission();
  } catch (e) {
    console.warn("[native] overlay permission check failed:", (e as Error)?.message || e);
  }
}

// Choose the background-liveness strategy for the current platform. In the native wrapper a
// foreground service holds the process alive far more reliably than the PWA's inaudible audio tone
// and needs no user gesture — so prefer it when the plugin is present. Falls back to the audio tone
// in a plain browser/PWA, or if a wrapper build hasn't registered the plugin yet.
export function createKeepAliveForPlatform(): KeepAlive {
  if (isNativeApp()) {
    const svc = getNativeForegroundService();
    if (svc) return createNativeKeepAlive(svc);
    console.warn("[KeepAlive] native app but no foreground-service plugin found — using audio keep-alive");
  }
  return createKeepAlive();
}
