import { describe, it, expect } from "vitest";
import { installNoZoom, isZoomWheel } from "./no-zoom";

describe("isZoomWheel", () => {
  it("treats a ctrl+wheel (trackpad pinch) as zoom", () => {
    expect(isZoomWheel({ ctrlKey: true } as WheelEvent)).toBe(true);
  });
  it("leaves a plain scroll wheel alone", () => {
    expect(isZoomWheel({ ctrlKey: false } as WheelEvent)).toBe(false);
  });
});

describe("installNoZoom", () => {
  it("cancels the iOS pinch gesture events", () => {
    const target = new EventTarget();
    installNoZoom(target);
    const ev = new Event("gesturestart", { cancelable: true });
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("cancels a ctrl+wheel zoom but not a plain scroll", () => {
    const target = new EventTarget();
    installNoZoom(target);

    const zoom = Object.assign(new Event("wheel", { cancelable: true }), { ctrlKey: true });
    target.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true);

    const scroll = Object.assign(new Event("wheel", { cancelable: true }), { ctrlKey: false });
    target.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
  });

  it("stops cancelling after the returned disposer runs", () => {
    const target = new EventTarget();
    const dispose = installNoZoom(target);
    dispose();
    const ev = new Event("gesturestart", { cancelable: true });
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
