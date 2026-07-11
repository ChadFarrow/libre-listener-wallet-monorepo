// Regenerate the PWA icon set from the app's logo-mark (ink bolt on the green gradient tile —
// the same mark as the drawer header and the extension's action icon). Run manually:
//   node scripts/generate-icons.mjs
// then commit the PNGs. Filenames are stable on purpose (no SW cache-list churn).
import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(new URL(import.meta.url)));
const outDir = join(here, "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const BOLT = "M13 3L4 14h6l-1 7 9-11h-6l1-7z";

// size: canvas edge; radiusPct: tile corner radius (0 = square, platform masks it);
// boltPct: bolt height as a fraction of the edge (maskable shrinks into the 80% safe zone).
function markSvg(size, { radiusPct, boltPct }) {
  const r = Math.round((size * radiusPct) / 100);
  const boltScale = (size * (boltPct / 100)) / 24; // the path lives in a 24x24 viewBox
  const offset = (size - 24 * boltScale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#2bd76c"/>
      <stop offset="1" stop-color="#17913f"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#g)"/>
  <g transform="translate(${offset} ${offset}) scale(${boltScale})">
    <path d="${BOLT}" fill="#04180b" stroke="#04180b" stroke-width="1.2" stroke-linejoin="round"/>
  </g>
</svg>`;
}

const TARGETS = [
  // Regular icons: rounded tile look on a transparent canvas.
  { file: "icon-192.png", size: 192, radiusPct: 22, boltPct: 62 },
  { file: "icon-512.png", size: 512, radiusPct: 22, boltPct: 62 },
  // Maskable: full-bleed square, bolt inside the ~80% safe zone — the platform rounds it.
  { file: "icon-512-maskable.png", size: 512, radiusPct: 0, boltPct: 50 },
  // Apple touch: fully opaque square (iOS shows black behind transparency artifacts).
  { file: "apple-touch-icon-180.png", size: 180, radiusPct: 0, boltPct: 58 },
];

const svgSource = markSvg(512, { radiusPct: 22, boltPct: 62 });
writeFileSync(join(outDir, "icon.svg"), svgSource);

for (const t of TARGETS) {
  const svg = markSvg(t.size, t);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  writeFileSync(join(outDir, t.file), png);
  console.log(`wrote ${t.file} (${png.length} bytes)`);
}
console.log("wrote icon.svg (source of truth)");
