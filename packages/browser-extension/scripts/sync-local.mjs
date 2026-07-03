// Sync the freshly built dist/ into the unpacked extension folder Chrome has loaded, so a Reload ↻
// picks up your changes. This is the documented safe-update path: it replaces the CONTENTS of the
// SAME folder Chrome loaded (never Remove — Chrome wipes ALL extension storage, wallet included, on
// removal). Because the manifest "key" pins the extension ID, the origin/IndexedDB/chrome.storage
// are preserved across the copy.
//
//   pnpm --filter @libre/browser-extension sync:local     # copy dist/ → install dir
//   pnpm --filter @libre/browser-extension build:local    # build, then copy
//
// Target dir: $LIBRE_EXT_INSTALL_DIR, else ~/Downloads/libre-listener-wallet-extension.
// Then hit Reload ↻ on the extension card at chrome://extensions.

import { existsSync, readFileSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = join(root, "dist");

const target = process.env.LIBRE_EXT_INSTALL_DIR
  ? resolve(process.env.LIBRE_EXT_INSTALL_DIR)
  : join(homedir(), "Downloads", "libre-listener-wallet-extension");

const die = (msg) => {
  console.error(`[sync-local] ${msg}`);
  process.exit(1);
};

// Read the "key" from a manifest.json — the pinned identity that must match, or the copy would
// re-ID the extension (Chrome would treat it as a different install and orphan the wallet storage).
const manifestKey = (dir) => {
  const p = join(dir, "manifest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")).key ?? null;
  } catch {
    return null;
  }
};

if (!existsSync(join(dist, "manifest.json"))) {
  die(`no build found at ${dist} — run "pnpm --filter @libre/browser-extension build" first.`);
}

if (!existsSync(target)) {
  die(
    `install dir not found:\n  ${target}\n\n` +
      `Point Chrome at it once (chrome://extensions → Load unpacked → select the folder), or set\n` +
      `LIBRE_EXT_INSTALL_DIR to the folder you loaded. This script won't create a folder Chrome\n` +
      `hasn't loaded — it only refreshes an existing install in place.`
  );
}

// Guard the pinned identity: refuse to clobber a folder whose extension ID differs from this build.
const distKey = manifestKey(dist);
const targetKey = manifestKey(target);
if (distKey && targetKey && distKey !== targetKey) {
  die(
    `manifest "key" mismatch — refusing to overwrite.\n` +
      `  build key:   ${distKey.slice(0, 24)}…\n` +
      `  install key: ${targetKey.slice(0, 24)}…\n` +
      `These are different extension IDs; copying would orphan the loaded wallet's storage.`
  );
}

cpSync(dist, target, { recursive: true });
console.log(`[sync-local] copied build → ${target}`);
console.log(`[sync-local] now hit Reload ↻ on the extension card at chrome://extensions (never Remove).`);
