import { defineConfig } from "vite";
import * as fs from "fs";
import * as path from "path";

// Dev-only host page for the embed. Serves the LDK WASM at /liblightningjs.wasm (what mount's
// wasmUrl points at) and proxies the regtest esplora like the wallet-pwa dev server does.
function serveWasm() {
  const candidates = [
    path.resolve(__dirname, "../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../libre-listener-wallet/node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  const wasm = candidates.find((p) => fs.existsSync(p));
  return {
    name: "serve-ldk-wasm",
    configureServer(server: { middlewares: { use(path: string, handler: (req: unknown, res: any) => void): void } }) {
      server.middlewares.use("/liblightningjs.wasm", (_req, res) => {
        if (!wasm) {
          res.statusCode = 404;
          res.end("wasm not found — pnpm install first");
          return;
        }
        res.setHeader("Content-Type", "application/wasm");
        fs.createReadStream(wasm).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [serveWasm()],
  server: {
    proxy: {
      "/regtest-esplora": { target: "http://127.0.0.1:3002", changeOrigin: true, rewrite: (p) => p.replace(/^\/regtest-esplora/, "") },
    },
  },
});
