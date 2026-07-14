// Whether the home screen should show the "Starting your node…" loading indicator instead of the
// bare "— sats" placeholder. It's shown during the launch window when the node isn't running yet but
// is (or is about to be) coming up, so startup reads as "loading" rather than "empty/stopped".
//
//  - running:     the node is up → the real balance shows, never the loader.
//  - starting:    a start is actually in flight → definitely loading.
//  - settling:    the post-launch settle window (home tracks it) — covers the brief gap before
//                 auto-start has called startNode, but ONLY when auto-start will actually run.
//  - autoStartOn: if auto-start is OFF, a stopped wallet isn't coming up on its own → don't claim to
//                 be loading; the "Node stopped — tap to start" pill owns that state after the window.
export function bootLoadingVisible(i: {
  running: boolean;
  starting: boolean;
  settling: boolean;
  autoStartOn: boolean;
}): boolean {
  if (i.running) return false;
  if (i.starting) return true;
  return i.settling && i.autoStartOn;
}
