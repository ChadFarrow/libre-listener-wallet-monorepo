// Pure view logic for the home-screen background-mode chip (keep-alive audio).
//
// The chip is the one reliable place to start keep-alive: a click is the trusted user gesture iOS
// demands before audio can play. Once playing, the node stays alive while the app is backgrounded so
// boosts sent from another app settle without switching back. This decides only what the chip shows;
// the click side effects (enable + unlock) live in the screen.

export interface BgChipState {
  // The node is real (not demo) and running — keep-alive only holds a live local node alive.
  nodeRunning: boolean;
  demo: boolean;
  // keep-alive audio is actually playing right now.
  active: boolean;
  // keep-alive is enabled in settings (persisted) but may not yet have been activated by a tap.
  enabled: boolean;
}

export interface BgChipView {
  visible: boolean;
  on: boolean;
  text: string;
}

export function bgChipView(s: BgChipState): BgChipView {
  if (s.demo || !s.nodeRunning) return { visible: false, on: false, text: "" };
  if (s.active) return { visible: true, on: true, text: "Background mode on" };
  return {
    visible: true,
    on: false,
    text: s.enabled ? "Tap to activate background mode" : "Keep boosts running in background",
  };
}
