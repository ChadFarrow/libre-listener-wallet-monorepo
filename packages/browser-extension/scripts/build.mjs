// Build the MV3 extension with esbuild. Each context is a separate bundle:
//   - background / offscreen / content-script / popup / options / approval → ESM modules
//   - inpage → IIFE (injected as a classic <script> into the page's main world)
// Every dependency is bundled (no bare specifiers survive) because extension worker/offscreen
// contexts can't resolve them — the same hard rule the PWA service-worker build discovered.
// Static assets (manifest.json, *.html, liblightningjs.wasm) are copied verbatim into dist/.

import * as esbuild from "esbuild";
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outdir = join(root, "dist");
const watch = process.argv.includes("--watch");

mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  // Bundle everything so no bare specifier survives — extension contexts can't resolve them.
  // The one exception is Node's built-in "crypto": lightningdevkit references it only in a
  // `typeof crypto === "undefined"` fallback that never runs in a browser (global crypto exists),
  // so we leave the (unreachable) dynamic import external instead of trying to bundle a Node
  // builtin. Same approach as the PWA service-worker build.
  external: ["crypto"],
};

// ESM-module entries (one output file each, named to match manifest/html references).
const moduleEntries = {
  background: "src/background.ts",
  offscreen: "src/offscreen/offscreen.ts",
  "content-script": "src/content-script.ts",
  popup: "src/popup/popup.ts",
  options: "src/options/options.ts",
  approval: "src/approval/approval.ts",
};

// The page provider is injected as a classic script → IIFE, not a module.
const inpageEntry = { inpage: "src/inpage/inpage.ts" };

function findWasm() {
  const candidates = [
    join(root, "node_modules/lightningdevkit/liblightningjs.wasm"),
    join(root, "../libre-listener-wallet/node_modules/lightningdevkit/liblightningjs.wasm"),
    join(root, "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  return candidates.find((p) => existsSync(p));
}

function copyStatic() {
  // manifest + html pages
  copyFileSync(join(root, "src/manifest.json"), join(outdir, "manifest.json"));
  const htmlPairs = [
    ["src/offscreen/offscreen.html", "offscreen.html"],
    ["src/popup/popup.html", "popup.html"],
    ["src/options/options.html", "options.html"],
    ["src/approval/approval.html", "approval.html"],
  ];
  for (const [from, to] of htmlPairs) copyFileSync(join(root, from), join(outdir, to));

  const wasm = findWasm();
  if (!wasm) throw new Error("Could not find liblightningjs.wasm in node_modules — run pnpm install first.");
  copyFileSync(wasm, join(outdir, "liblightningjs.wasm"));
  console.log("[build] copied manifest, html, and liblightningjs.wasm");
}

async function run() {
  const ctxs = [];

  const moduleBuild = {
    ...common,
    entryPoints: Object.fromEntries(Object.entries(moduleEntries).map(([k, v]) => [k, join(root, v)])),
    outdir,
    splitting: false,
  };
  const inpageBuild = {
    ...common,
    format: "iife",
    entryPoints: Object.fromEntries(Object.entries(inpageEntry).map(([k, v]) => [k, join(root, v)])),
    outdir,
  };

  if (watch) {
    ctxs.push(await esbuild.context(moduleBuild));
    ctxs.push(await esbuild.context(inpageBuild));
    copyStatic();
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[build] watching…");
  } else {
    await esbuild.build(moduleBuild);
    await esbuild.build(inpageBuild);
    copyStatic();
    console.log("[build] done →", outdir);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
