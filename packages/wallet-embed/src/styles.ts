// Shadow-DOM stylesheet for <libre-wallet>. Alby-Go-style tokens (the v4vmusic green accent, ink
// on gradient) in a compact, mobile-first card: ≥44px touch targets, ≥16px inputs (iOS focus-zoom
// rule), container-relative sizing only — the widget must never assume viewport ownership.
//
// THEMING: every colour is a --lw-* custom property on :host, and an embedding app can restyle the
// whole card to its own palette just by setting them on the element (`libre-wallet { --lw-bg: … }`)
// — custom properties inherit through the shadow boundary, and an outer page's declarations beat
// :host. Keep it that way: a literal colour anywhere in here is unthemeable from outside.
export const EMBED_CSS = `
:host {
  all: initial;
  display: block;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --lw-accent: #22c45e;
  --lw-accent-2: #2bd76c;
  /* Second stop of the mark's gradient. A token, not a literal, so an embedding app can theme the
     card to its own palette — every other colour here is already overridable via :host custom
     properties (an outer page's declarations beat :host), and one hardcoded hex left the mark
     stubbornly Libre-green inside an otherwise fully restyled widget. */
  --lw-accent-3: #17913f;
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
  background: linear-gradient(135deg, var(--lw-accent-2), var(--lw-accent-3));
  color: var(--lw-ink); font-size: 13px; font-weight: 800;
  display: flex; align-items: center; justify-content: center;
}
.title { font-size: 14px; font-weight: 700; }
.net { margin-left: auto; font-size: 11px; color: var(--lw-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.body { display: grid; gap: 10px; }
.msg { font-size: 13.5px; color: var(--lw-muted); line-height: 1.45; }
.msg.bad { color: var(--lw-bad); }
.msg.warn { color: var(--lw-warn); }
/* font-family: inherit — form controls do NOT inherit fonts (the UA stylesheet gives them their
   own), so without this the buttons and the input silently render in the browser's default face
   while the rest of the card uses :host's. Invisible with the stock system-ui stack; glaring the
   moment an embedding app sets a real font. Size/weight stay explicit below. */
button.primary, button.secondary, button.danger, button.link-btn, input.field, .check { font-family: inherit; }
button.primary, button.secondary, button.danger {
  min-height: 44px; border-radius: 10px; font-size: 15px; font-weight: 700;
  width: 100%; cursor: pointer; border: none;
}
button.primary { background: var(--lw-accent); color: var(--lw-ink); }
button.primary:disabled { opacity: 0.55; cursor: default; }
button.secondary { background: transparent; color: var(--lw-fg); border: 1px solid var(--lw-line); }
/* Destructive, and deliberately NOT accent-green: this one force-closes a channel. It only ever
   appears after the consequence has been spelled out (element.ts, the overridable halt). */
button.danger { background: transparent; color: var(--lw-bad); border: 1px solid var(--lw-bad); }
/* The reveal that precedes it — text, not a button-shaped thing, so it reads as "tell me more"
   rather than as a second action competing with "Try again". */
button.link-btn {
  background: none; border: none; padding: 4px 0; width: 100%;
  color: var(--lw-fg); opacity: 0.7; font-size: 13px; text-align: left;
  text-decoration: underline; cursor: pointer;
}
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
/* A top-layer <dialog> (see element.ts requestApproval): it escapes the card and the host's
   stacking context, so the approval is always reachable — the promise only settles on a click.
   Centred by the dialog default; the dim is the backdrop's job now, not an inset overlay's. */
.overlay {
  border: 1px solid var(--lw-line); border-radius: 14px; padding: 14px;
  background: var(--lw-bg); color: var(--lw-fg);
  width: min(340px, calc(100vw - 32px));
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
}
.overlay::backdrop { background: rgb(0 0 0 / 0.55); }
.sheet { display: grid; gap: 10px; width: 100%; }
.sheet h3 { font-size: 15px; }
.check { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--lw-muted); }
.check input { width: 18px; height: 18px; }
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.fineprint { font-size: 11.5px; color: var(--lw-muted); }
`;
