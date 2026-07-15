// Copy the LDK WASM binary into dist/ so the packed artifact carries everything a consumer needs
// (they copy it into their static dir and pass its URL as `wasmUrl`). Same multi-path resolution
// as the PWA's copyLdkWasmPlugin — pnpm hoists differently depending on install layout.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  join(root, "node_modules/lightningdevkit/liblightningjs.wasm"),
  join(root, "../libre-listener-wallet/node_modules/lightningdevkit/liblightningjs.wasm"),
  join(root, "../../node_modules/lightningdevkit/liblightningjs.wasm"),
];
const wasm = candidates.find((p) => existsSync(p));
if (!wasm) {
  console.error("copy-wasm: liblightningjs.wasm not found — run pnpm install first.");
  process.exit(1);
}
mkdirSync(join(root, "dist"), { recursive: true });
copyFileSync(wasm, join(root, "dist/liblightningjs.wasm"));
console.log(`copy-wasm: ${wasm} → dist/liblightningjs.wasm`);
