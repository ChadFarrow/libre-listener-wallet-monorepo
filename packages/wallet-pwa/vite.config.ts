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

// Dev-only: pin regtest fee estimates low. Soak/integration runs leave high-fee txs in the regtest
// chain, training bitcoind's estimator up to ~50 sat/vB; the wallet then demands ≥12500 sat/kw and
// rejects lnd's 2500 sat/kw channel opens ("Peer's feerate much too low"). Runs before the
// /regtest-esplora proxy, so only the fee-estimates route is overridden.
function regtestFeeEstimatesPlugin() {
  return {
    name: "regtest-fee-estimates",
    configureServer(server: { middlewares: { use(path: string, fn: (req: unknown, res: { setHeader(k: string, v: string): void; end(s: string): void }) => void): void } }) {
      server.middlewares.use("/regtest-esplora/fee-estimates", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ "1": 2.0, "6": 2.0, "144": 2.0, "1008": 2.0 }));
      });
    }
  };
}

export default defineConfig({
  // Relative base so the build works at a domain root (Cloudflare) AND a project
  // subpath (GitHub Pages, e.g. /libre-listener-wallet-monorepo/) with no rebuild.
  // The SW + WASM paths below are made base-aware to match.
  base: "./",
  plugins: [copyLdkWasmPlugin(), regtestFeeEstimatesPlugin()],
  server: {
    port: 5173,
    // Bind loopback only. `host: true` exposes the dev server (which sits next to
    // a wallet origin) to the LAN and to drive-by websites via known Vite/esbuild
    // dev-server advisories. Use `vite --host` explicitly if LAN access is needed.
    host: "127.0.0.1",
    // Dev-only: the page CSP allows connect-src 'self' https: wss:, so plaintext http:/ws:
    // fetches to local test services are blocked. Proxy them same-origin instead:
    // - /mock-lsps1 → the mock LSPS1 server (VITE_LSPS1_MOCK_URL=/mock-lsps1/v1)
    // - /regtest-esplora → the docker regtest electrs (set Esplora URL to
    //   http://127.0.0.1:5173/regtest-esplora in Settings when on regtest)
    // - /regtest-bridge → the docker websockify WS→TCP bridge to libre-lnd:9735 (set
    //   bridge URL to ws://127.0.0.1:5173/regtest-bridge; CSP 'self' covers same-origin ws)
    proxy: {
      "/mock-lsps1": "http://127.0.0.1:9098",
      "/regtest-esplora": {
        target: "http://127.0.0.1:3002",
        rewrite: (p: string) => p.replace(/^\/regtest-esplora/, "")
      },
      "/regtest-bridge": {
        target: "ws://127.0.0.1:8091",
        ws: true
      }
    }
  }
});
