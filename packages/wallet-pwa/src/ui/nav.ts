// Navigation owner: the screen stack (core/screen-router state + DOM transitions), the
// settings drawer, the transactions bottom sheet, and the browser-history integration that
// makes Android's back gesture pop modal-most-first (sheet/drawer before screens) instead of
// exiting the app. One history entry is pushed per opened layer; popstate closes down to the
// entry's recorded depth, so multi-entry jumps (history.go(-n)) also resolve correctly.

import { initialStack, push, pop, current, type ScreenStack } from "../core/screen-router";

export interface ScreenHooks {
  onShow?: () => void | Promise<void>;
  onHide?: () => void;
}

type Layer = { kind: "screen" } | { kind: "drawer" } | { kind: "sheet" };

const registry = new Map<string, ScreenHooks>();
let stack: ScreenStack = initialStack("screen-home");
let layers: Layer[] = [];
let sheetOnOpen: (() => void) | undefined;

export function registerScreen(id: string, hooks: ScreenHooks = {}): void {
  registry.set(id, hooks);
}

export function currentScreen(): string {
  return current(stack);
}

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function pushHistoryLayer(layer: Layer): void {
  layers.push(layer);
  try {
    history.pushState({ depth: layers.length }, "");
  } catch {
    // jsdom/file: contexts can refuse — navigation still works, only the back gesture degrades
  }
}

// ---- screens ----

function applyPush(prevId: string, nextId: string): void {
  const prev = el(prevId);
  const next = el(nextId);
  if (prev && next) {
    prev.classList.add("behind");
    prev.classList.remove("current");
    next.classList.add("current");
    window.setTimeout(() => prev.classList.remove("behind"), 450);
  }
  registry.get(prevId)?.onHide?.();
  const hooks = registry.get(nextId);
  if (hooks?.onShow) void hooks.onShow();
}

function applyPop(prevId: string, nextId: string): void {
  const prev = el(prevId);
  const next = el(nextId);
  if (prev && next) {
    next.classList.add("behind");
    prev.classList.remove("current"); // slides out over the revealed screen
    window.setTimeout(() => {
      next.classList.remove("behind");
      next.classList.add("current");
    }, 430);
  }
  registry.get(prevId)?.onHide?.();
  const hooks = registry.get(nextId);
  if (hooks?.onShow) void hooks.onShow();
}

export function showScreen(id: string): void {
  const prevId = current(stack);
  const nextStack = push(stack, id);
  if (nextStack === stack) return;
  stack = nextStack;
  pushHistoryLayer({ kind: "screen" });
  applyPush(prevId, id);
}

// UI-initiated back (the ← buttons). Routed through history so the button and the platform
// back gesture share one code path; falls back to a direct pop when no layer was recorded.
export function goBack(): void {
  if (layers.length > 0) history.back();
  else performScreenPop();
}

function performScreenPop(): void {
  const prevId = current(stack);
  const nextStack = pop(stack);
  if (nextStack === stack) return;
  stack = nextStack;
  applyPop(prevId, current(stack));
}

// Instant home reset for flow completions ("Later", post-restore): closes every layer with no
// animation churn and re-anchors history depth. Older history entries become inert no-ops.
export function resetToHome(): void {
  layers = [];
  stack = initialStack(stack[0]);
  for (const s of Array.from(document.querySelectorAll<HTMLElement>(".screen"))) {
    const isRoot = s.id === stack[0];
    s.classList.toggle("current", isRoot);
    s.classList.remove("behind");
  }
  setDrawer(false);
  setSheet(false);
  try {
    history.replaceState({ depth: 0 }, "");
  } catch {
    /* see pushHistoryLayer */
  }
  const hooks = registry.get(stack[0]);
  if (hooks?.onShow) void hooks.onShow();
}

// ---- drawer & sheet (overlays, not stack entries) ----

function syncScrim(): void {
  const drawerOpen = el("drawer")?.classList.contains("open");
  const sheetOpen = el("sheet")?.classList.contains("open");
  el("scrim")?.classList.toggle("show", !!drawerOpen || !!sheetOpen);
}

function setDrawer(open: boolean): void {
  el("drawer")?.classList.toggle("open", open);
  syncScrim();
}

function setSheet(open: boolean): void {
  el("sheet")?.classList.toggle("open", open);
  syncScrim();
  if (open) sheetOnOpen?.();
}

export function openDrawer(): void {
  if (el("drawer")?.classList.contains("open")) return;
  setDrawer(true);
  pushHistoryLayer({ kind: "drawer" });
}

export function closeDrawer(): void {
  if (!el("drawer")?.classList.contains("open")) return;
  if (layers[layers.length - 1]?.kind === "drawer") history.back();
  else setDrawer(false);
}

export function openSheet(): void {
  if (el("sheet")?.classList.contains("open")) return;
  setSheet(true);
  pushHistoryLayer({ kind: "sheet" });
}

export function closeSheet(): void {
  if (!el("sheet")?.classList.contains("open")) return;
  if (layers[layers.length - 1]?.kind === "sheet") history.back();
  else setSheet(false);
}

// Screens ask to refresh the sheet content when it opens (transactions list).
export function onSheetOpen(cb: () => void): void {
  sheetOnOpen = cb;
}

export function isSheetOpen(): boolean {
  return !!el("sheet")?.classList.contains("open");
}

// ---- init: DOM wiring + popstate ----

export function initNav(): void {
  try {
    history.replaceState({ depth: 0 }, "");
  } catch {
    /* see pushHistoryLayer */
  }

  window.addEventListener("popstate", (e: PopStateEvent) => {
    const target = typeof (e.state as { depth?: number } | null)?.depth === "number" ? (e.state as { depth: number }).depth : 0;
    while (layers.length > target) {
      const layer = layers.pop()!;
      if (layer.kind === "drawer") setDrawer(false);
      else if (layer.kind === "sheet") setSheet(false);
      else performScreenPop();
    }
  });

  for (const btn of Array.from(document.querySelectorAll<HTMLElement>(".back"))) {
    btn.addEventListener("click", () => goBack());
  }
  el("btn-drawer")?.addEventListener("click", () => openDrawer());
  el("scrim")?.addEventListener("click", () => {
    // Top-most overlay wins (matches the layer order the back gesture uses).
    if (layers[layers.length - 1]?.kind === "sheet") closeSheet();
    else if (layers[layers.length - 1]?.kind === "drawer") closeDrawer();
    else {
      setDrawer(false);
      setSheet(false);
    }
  });
  el("btn-sheet")?.addEventListener("click", () => openSheet());
  el("btn-sheet-close")?.addEventListener("click", () => closeSheet());

  wireSheetGestures();
}

// Touch drag-dismiss on the sheet + swipe-up-to-open on home (ported from the mockup).
function wireSheetGestures(): void {
  const sheet = el("sheet");
  const home = el("screen-home");
  if (sheet) {
    let dragY: number | null = null;
    sheet.addEventListener(
      "touchstart",
      (e) => {
        const list = el("txlist");
        if (list && list.contains(e.target as Node) && list.scrollTop > 0) return;
        dragY = e.touches[0].clientY;
        sheet.style.transition = "none";
      },
      { passive: true },
    );
    sheet.addEventListener(
      "touchmove",
      (e) => {
        if (dragY === null) return;
        const dy = Math.max(0, e.touches[0].clientY - dragY);
        sheet.style.transform = `translateY(${dy}px)`;
      },
      { passive: true },
    );
    sheet.addEventListener(
      "touchend",
      (e) => {
        if (dragY === null) return;
        const dy = e.changedTouches[0].clientY - dragY;
        sheet.style.transition = "";
        sheet.style.transform = "";
        if (dy > 90) closeSheet();
        dragY = null;
      },
      { passive: true },
    );
  }
  if (home) {
    let homeY: number | null = null;
    home.addEventListener("touchstart", (e) => (homeY = e.touches[0].clientY), { passive: true });
    home.addEventListener(
      "touchend",
      (e) => {
        if (homeY !== null && homeY - e.changedTouches[0].clientY > 60) openSheet();
        homeY = null;
      },
      { passive: true },
    );
  }
}
