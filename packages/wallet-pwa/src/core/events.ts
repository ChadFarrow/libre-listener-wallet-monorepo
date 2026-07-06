// Tiny in-page event bus. In the extension, views heard wallet changes over chrome.runtime
// (onWalletEvent); in the single-page PWA the WalletController emits directly and views subscribe
// here. main.ts wires the controller's emit callback into emitControllerEvent.
type Listener = (event: string, payload?: unknown) => void;

const listeners = new Set<Listener>();

export function onControllerEvent(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitControllerEvent(event: string, payload?: unknown): void {
  for (const cb of listeners) {
    try {
      cb(event, payload);
    } catch (e) {
      console.warn("[events] listener threw:", (e as Error)?.message || e);
    }
  }
}
