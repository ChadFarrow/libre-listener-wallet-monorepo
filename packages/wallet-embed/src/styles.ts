// Shadow-DOM stylesheet for <libre-wallet>. Alby-Go-style tokens (the v4vmusic green accent, ink
// on gradient) in a compact, mobile-first card: ≥44px touch targets, ≥16px inputs (iOS focus-zoom
// rule), container-relative sizing only — the widget must never assume viewport ownership.
export const EMBED_CSS = `
:host {
  all: initial;
  display: block;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --lw-accent: #22c45e;
  --lw-accent-2: #2bd76c;
  --lw-ink: #04180b;
  --lw-bg: #ffffff;
  --lw-fg: #10241a;
  --lw-muted: #5b6f63;
  --lw-line: #dbe7df;
  --lw-bad: #d64545;
  --lw-warn: #b98a1c;
}
@media (prefers-color-scheme: dark) {
  :host {
    --lw-bg: #0d1712;
    --lw-fg: #e7f2ea;
    --lw-muted: #94a89b;
    --lw-line: #24352b;
  }
}
* { box-sizing: border-box; margin: 0; }
.card {
  background: var(--lw-bg);
  color: var(--lw-fg);
  border: 1px solid var(--lw-line);
  border-radius: 14px;
  padding: 14px;
  max-width: 420px;
  position: relative;
}
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.mark {
  width: 22px; height: 22px; border-radius: 6px; flex: none;
  background: linear-gradient(135deg, var(--lw-accent-2), #17913f);
  color: var(--lw-ink); font-size: 13px; font-weight: 800;
  display: flex; align-items: center; justify-content: center;
}
.title { font-size: 14px; font-weight: 700; }
.net { margin-left: auto; font-size: 11px; color: var(--lw-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.body { display: grid; gap: 10px; }
.msg { font-size: 13.5px; color: var(--lw-muted); line-height: 1.45; }
.msg.bad { color: var(--lw-bad); }
.msg.warn { color: var(--lw-warn); }
button.primary, button.secondary {
  min-height: 44px; border-radius: 10px; font-size: 15px; font-weight: 700;
  width: 100%; cursor: pointer; border: none;
}
button.primary { background: var(--lw-accent); color: var(--lw-ink); }
button.primary:disabled { opacity: 0.55; cursor: default; }
button.secondary { background: transparent; color: var(--lw-fg); border: 1px solid var(--lw-line); }
a.link { color: var(--lw-accent); font-size: 13px; text-decoration: none; }
input.field {
  min-height: 44px; font-size: 16px; /* <16px would trigger iOS focus-zoom */
  border: 1px solid var(--lw-line); border-radius: 10px; padding: 0 12px;
  width: 100%; background: transparent; color: var(--lw-fg);
}
.row { display: flex; align-items: center; gap: 8px; }
.balance { font-size: 26px; font-weight: 800; letter-spacing: -0.01em; }
.balance small { font-size: 13px; font-weight: 600; color: var(--lw-muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--lw-accent); flex: none; }
.dot.off { background: var(--lw-muted); }
.spin {
  width: 16px; height: 16px; flex: none; border-radius: 50%;
  border: 2px solid var(--lw-line); border-top-color: var(--lw-accent);
  animation: lw-spin 0.8s linear infinite;
}
@keyframes lw-spin { to { transform: rotate(360deg); } }
.overlay {
  position: absolute; inset: 0; border-radius: 14px;
  background: color-mix(in srgb, var(--lw-bg) 92%, transparent);
  display: flex; align-items: center; justify-content: center; padding: 14px;
}
.overlay[hidden] { display: none; }
.sheet { display: grid; gap: 10px; width: 100%; }
.sheet h3 { font-size: 15px; }
.check { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--lw-muted); }
.check input { width: 18px; height: 18px; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.fineprint { font-size: 11.5px; color: var(--lw-muted); }
`;
