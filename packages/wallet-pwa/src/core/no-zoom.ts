// Native-app feel: block every zoom gesture the viewport meta can't fully suppress.
//
// The viewport meta (`maximum-scale=1, user-scalable=no`) fully covers a standalone
// home-screen PWA and Android Chrome. But two cases slip past it:
//   - iOS Safari *tabs* deliberately ignore `user-scalable=no` (accessibility), so the
//     only way to stop pinch-zoom there is to preventDefault the gesture* events iOS fires.
//   - Desktop trackpad / ctrl+wheel pinch-zoom arrives as a `wheel` event with `ctrlKey`.
//
// Double-tap-to-zoom is handled declaratively by `touch-action: manipulation` in style.css.
// Listeners must be `passive: false` or preventDefault is a no-op.

/** True for a wheel event that represents a pinch/ctrl zoom (trackpad pinch fires ctrlKey wheel). */
export function isZoomWheel(e: WheelEvent): boolean {
  return e.ctrlKey;
}

export function installNoZoom(target: EventTarget = window): () => void {
  const block = (e: Event) => {
    if (e.cancelable) e.preventDefault();
  };
  const onWheel = (e: Event) => {
    if (isZoomWheel(e as WheelEvent) && e.cancelable) e.preventDefault();
  };
  const opts: AddEventListenerOptions = { passive: false };
  target.addEventListener("gesturestart", block, opts);
  target.addEventListener("gesturechange", block, opts);
  target.addEventListener("gestureend", block, opts);
  target.addEventListener("wheel", onWheel, opts);
  return () => {
    target.removeEventListener("gesturestart", block, opts);
    target.removeEventListener("gesturechange", block, opts);
    target.removeEventListener("gestureend", block, opts);
    target.removeEventListener("wheel", onWheel, opts);
  };
}
