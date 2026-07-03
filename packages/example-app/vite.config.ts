import { defineConfig } from "vite";
import * as fs from "fs";
import * as path from "path";

// Custom plugin to copy liblightningjs.wasm to public directory
function copyLdkWasmPlugin() {
  return {
    name: "copy-ldk-wasm",
    buildStart() {
      const publicDir = path.resolve(__dirname, "public");
      if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
      }

      // Run tsup to compile the service worker. A failure here MUST abort the
      // build: public/service-worker.js is gitignored, so swallowing the error
      // would ship a deploy with no service worker (web-push wake silently dead)
      // while CI stays green.
      console.log("[vite-plugin] Compiling Service Worker with tsup...");
      const { execSync } = require("child_process");
      execSync("npx tsup", { cwd: __dirname, stdio: "inherit" });
      console.log("[vite-plugin] Service Worker compiled successfully!");

      // Try multiple potential paths to resolve the WASM in pnpm monorepo
      const candidatePaths = [
        path.resolve(__dirname, "node_modules/lightningdevkit/liblightningjs.wasm"),
        path.resolve(__dirname, "../libre-listener-wallet/node_modules/lightningdevkit/liblightningjs.wasm"),
        path.resolve(__dirname, "../../node_modules/lightningdevkit/liblightningjs.wasm"),
      ];

      let found = false;
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          fs.copyFileSync(p, path.join(publicDir, "liblightningjs.wasm"));
          console.log(`[vite-plugin] Copied LDK WASM from ${p} to public directory`);
          found = true;
          break;
        }
      }

      if (!found) {
        throw new Error("Could not find liblightningjs.wasm in node_modules");
      }
    }
  };
}

export default defineConfig({
  // Relative base so the build works at a domain root (Cloudflare) AND a project
  // subpath (GitHub Pages, e.g. /libre-listener-wallet-monorepo/) with no rebuild.
  // The SW + WASM paths below are made base-aware to match.
  base: "./",
  plugins: [copyLdkWasmPlugin()],
  server: {
    port: 5173,
    // Bind loopback only. `host: true` exposes the dev server (which sits next to
    // a wallet origin) to the LAN and to drive-by websites via known Vite/esbuild
    // dev-server advisories. Use `vite --host` explicitly if LAN access is needed.
    host: "127.0.0.1"
  }
});
