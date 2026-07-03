// Toolbar action icon that reflects node liveness: the extension ships no icon assets, so the
// service worker draws a lightning bolt at runtime — brand green when the LDK node is running,
// muted grey when it's stopped — and sets it via chrome.action.setIcon. Kept assetless so a build
// is just JS; the drawing (OffscreenCanvas) only runs in the service worker, never in tests.

// Locked to the v4vmusic accent green used across the popup/options/approval UI (--accent).
export const ICON_LIVE_COLOR = "#22c45e";
export const ICON_IDLE_COLOR = "#9ca3af";

export function iconColorFor(running: boolean): string {
  return running ? ICON_LIVE_COLOR : ICON_IDLE_COLOR;
}

// Lightning-bolt polygon in a unit square (y grows downward), scaled to each icon size.
const BOLT: ReadonlyArray<readonly [number, number]> = [
  [0.6, 0.05],
  [0.28, 0.54],
  [0.47, 0.54],
  [0.38, 0.95],
  [0.74, 0.44],
  [0.54, 0.44],
];

// Draw the bolt filled in `color` on a transparent square and return its pixels. Uses
// OffscreenCanvas, which exists in the MV3 service worker but not in the node test environment —
// so this is never called from tests (only iconColorFor is).
function drawIcon(size: number, color: string): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable for action icon");
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = color;
  ctx.beginPath();
  BOLT.forEach(([x, y], i) => {
    const px = x * size;
    const py = y * size;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

// The size→ImageData map chrome.action.setIcon expects, rendered for the given liveness.
export function buildIconSet(running: boolean): Record<number, ImageData> {
  const color = iconColorFor(running);
  return { 16: drawIcon(16, color), 32: drawIcon(32, color), 48: drawIcon(48, color) };
}
