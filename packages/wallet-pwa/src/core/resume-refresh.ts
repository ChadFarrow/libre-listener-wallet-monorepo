// Whether to proactively refresh peer connections when the page becomes visible again. On iOS a
// backgrounded PWA is frozen and its bridge socket can die WITHOUT an onclose (a "zombie" half-open
// connection that LDK still lists as connected), so a plain resume leaves a ~10-20s window where the
// wallet looks connected but sends silently stall. We fix that by dropping + redialing peers on
// resume — but only when the tab is actually visible AND the node is running (nothing to refresh
// otherwise). Pure so the trigger decision is unit-tested; main.ts wires the DOM event.
export function shouldRefreshOnVisible(visibilityState: string, running: boolean): boolean {
  return visibilityState === "visible" && running;
}
