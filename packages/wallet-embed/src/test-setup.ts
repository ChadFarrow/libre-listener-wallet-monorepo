// jsdom does not implement <dialog> (verified on 24.x and on 29.x — bumping does not help), so
// showModal/close simply don't exist and every approval test would throw. The approval sheet has
// to be a real top-layer dialog in the browser: the promise it returns settles only on a click, so
// an unreachable sheet hangs the host's payment forever (see element.ts requestApproval).
//
// This shim models the part jsdom CAN observe — open state, the `close` event, and Esc dismissal —
// so the tests still exercise the real sheet markup, the real handlers, and every path that
// settles the promise. Top-layer compositing itself is not modelled by jsdom under any
// configuration; that is verified in a browser, not here.
import { beforeAll } from "vitest";

beforeAll(() => {
  const proto = window.HTMLDialogElement?.prototype;
  if (!proto || typeof proto.showModal === "function") return;

  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
    // Esc is a native dismissal of a modal dialog and fires `cancel` then `close` — the buttons
    // never see it, so element.ts has to settle on `close`. Tests must be able to reach that path.
    // Not `{ once: true }`: that spends the listener on the FIRST key of any kind, so a test that
    // types into the sheet before pressing Escape would silently stop being a test of Escape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      this.removeEventListener("keydown", onKey);
      this.close();
    };
    this.addEventListener("keydown", onKey);
  };

  proto.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };

  proto.close = function close(this: HTMLDialogElement, returnValue?: string) {
    if (!this.open) return;
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  };
});
