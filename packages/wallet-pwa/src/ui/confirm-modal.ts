// A tiny, dependency-free confirmation modal for destructive actions (wallet reset, revoke access,
// delete pairing). Returns a promise that resolves true on confirm, false on cancel/escape/backdrop.
// Styles are applied programmatically (CSSOM), which is not subject to the extension's style-src CSP.

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function confirmModal(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:2147483647;padding:16px;";

    const box = document.createElement("div");
    box.style.cssText =
      "background:Canvas;color:CanvasText;max-width:360px;width:100%;border-radius:12px;padding:20px;" +
      "font:14px/1.5 system-ui,sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.4);";

    const h = document.createElement("h3");
    h.textContent = opts.title;
    h.style.cssText = "margin:0 0 10px;font-size:16px;";

    const p = document.createElement("p");
    p.textContent = opts.body;
    p.style.cssText = "margin:0 0 20px;";

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;justify-content:flex-end;";

    const cancel = document.createElement("button");
    cancel.textContent = opts.cancelLabel || "Cancel";
    cancel.style.cssText = "padding:8px 14px;border-radius:8px;border:0;background:#8883;color:inherit;cursor:pointer;font:inherit;font-weight:600;";

    const ok = document.createElement("button");
    ok.textContent = opts.confirmLabel || "Confirm";
    ok.style.cssText =
      "padding:8px 14px;border-radius:8px;border:0;color:#fff;cursor:pointer;font:inherit;font-weight:600;background:" +
      (opts.danger ? "#c0392b" : "#22c45e") + ";";

    const close = (v: boolean) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(true);
    };

    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey);

    row.append(cancel, ok);
    box.append(h, p, row);
    overlay.append(box);
    document.body.append(overlay);
    ok.focus();
  });
}
