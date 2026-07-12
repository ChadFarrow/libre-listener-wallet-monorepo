import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor config for the native Android wrapper. `webDir` points at the wallet-pwa's BUILT output,
// so `cap sync` copies the existing PWA into the Android app unchanged — the WASM LDK node is not
// recompiled. Build wallet-pwa first (`turbo run build --filter=@libre/wallet-pwa`), then `cap sync`.
const config: CapacitorConfig = {
  appId: "com.v4vmusic.librelistener",
  appName: "Libre Listener",
  webDir: "../wallet-pwa/dist",
  server: {
    // Serve over https://localhost so navigator.locks (the single-node lock), IndexedDB, service
    // workers, and other secure-context APIs the wallet relies on all work. A file:// WebView
    // silently breaks Web Locks — do not change this to a file scheme.
    androidScheme: "https",
  },
};

export default config;
