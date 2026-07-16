import { describe, it, expect, vi, beforeAll } from "vitest";
import { ELEMENT_TAG, LibreWalletElement, registerLibreWallet } from "./element";
import type { ElementHooks } from "./element";
import { EMBED_CSS } from "./styles";

function mountEl(hooks: Partial<ElementHooks> = {}): LibreWalletElement {
  const el = document.createElement(ELEMENT_TAG) as LibreWalletElement;
  el.wire({
    onConnect: () => {},
    onSubmitSecret: () => {},
    onMoveHere: () => {},
    onRetry: () => {},
    onDisconnect: () => {},
    walletAppUrl: "https://wallet.example",
    ...hooks,
  });
  document.body.appendChild(el);
  return el;
}

const sr = (el: LibreWalletElement) => el.shadowRoot!;
const text = (el: LibreWalletElement) => sr(el).textContent ?? "";
/** Only what's RENDERED — sr().textContent also carries the stylesheet, so an assertion that some
 *  copy is absent can otherwise be satisfied (or broken) by a CSS comment. */
const bodyText = (el: LibreWalletElement) => sr(el).querySelector('[data-ref="body"]')?.textContent ?? "";

describe("stylesheet is themeable by the embedding app", () => {
  // Custom properties inherit through the shadow boundary and an outer page's declarations beat
  // :host, so a host can restyle the card entirely — but ONLY for colours routed through a token.
  // A literal hex outside the :host block is invisible to the host and leaves the widget stuck in
  // Libre green inside an otherwise re-themed card (this is exactly what --lw-accent-3 fixed).
  it("declares no literal colour outside the :host token block", () => {
    const hostBlockEnd = EMBED_CSS.indexOf("* { box-sizing");
    const rules = EMBED_CSS.slice(hostBlockEnd);
    const literals = rules.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(literals, `theme these via a --lw-* token: ${literals.join(", ")}`).toEqual([]);
  });
});

beforeAll(() => {
  registerLibreWallet();
});

describe("<libre-wallet> views", () => {
  it("renders the connect entry view with the wallet-app link", () => {
    const onConnect = vi.fn();
    const el = mountEl({ onConnect });
    el.renderConnect();
    const btn = sr(el).querySelector("button.primary")!;
    expect(btn.textContent).toBe("Connect Libre Wallet");
    expect(sr(el).querySelector("a.link")!.getAttribute("href")).toBe("https://wallet.example");
    (btn as HTMLButtonElement).click();
    expect(onConnect).toHaveBeenCalledOnce();
    expect((btn as HTMLButtonElement).disabled).toBe(true); // single-flight
  });

  it("blocked view names the holding origin's host and wires Move-here", () => {
    const onMoveHere = vi.fn();
    const el = mountEl({ onMoveHere });
    el.renderState({ view: "blocked", origin: "https://a.example", expiresAt: 1 });
    expect(text(el)).toContain("active on a.example");
    (sr(el).querySelector("button.primary") as HTMLButtonElement).click();
    expect(onMoveHere).toHaveBeenCalledOnce();
  });

  it("need-secret submits the trimmed input value", () => {
    const onSubmitSecret = vi.fn();
    const el = mountEl({ onSubmitSecret });
    el.renderState({ view: "need-secret" });
    const input = sr(el).querySelector("input.field") as HTMLInputElement;
    input.value = "  correct horse  ";
    (sr(el).querySelector("button.primary") as HTMLButtonElement).click();
    expect(onSubmitSecret).toHaveBeenCalledWith("correct horse");
  });

  it("running view shows the balance and wires Disconnect", () => {
    const onDisconnect = vi.fn();
    const el = mountEl({ onDisconnect });
    el.setBalance("1,549 sats");
    el.renderState({ view: "running" });
    expect(text(el)).toContain("1,549 sats");
    (sr(el).querySelector("button.secondary") as HTMLButtonElement).click();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("halted view surfaces the message text and a retry", () => {
    const onRetry = vi.fn();
    const el = mountEl({ onRetry });
    el.renderState({ view: "halted", reason: "version-gap", message: "Open a.example once so it can sync." });
    expect(text(el)).toContain("Open a.example once");
    (sr(el).querySelector("button.secondary") as HTMLButtonElement).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  // The escape hatch for "my phone is gone for good". It force-closes a live channel, so it must be
  // a deliberate, informed act — never a second button next to "Try again" that a user mashes after
  // the first one didn't work. Reveal the consequence first; only then offer the button.
  it("an overridable halt hides the force-restore behind a confirm, not a second retry", () => {
    const onForceRestore = vi.fn();
    const onRetry = vi.fn();
    const el = mountEl({ onForceRestore, onRetry });
    el.renderState({
      view: "halted",
      reason: "version-gap",
      message: "Open a.example once so it can sync.",
      override: { staleOrigin: "https://a.example" },
    });
    // Nothing about force-closing is shown, and no force button exists, until the user asks.
    expect(bodyText(el)).not.toMatch(/force-close/i);
    expect(sr(el).querySelector("button.danger")).toBeNull();

    const reveal = sr(el).querySelector("button.link-btn") as HTMLButtonElement;
    expect(reveal.textContent).toMatch(/gone/i);
    reveal.click();
    expect(onForceRestore).not.toHaveBeenCalled(); // revealing is not consenting

    expect(bodyText(el)).toMatch(/force-close/i);
    expect(bodyText(el)).toMatch(/on-chain/i); // says where the money goes
    const confirm = sr(el).querySelector("button.danger") as HTMLButtonElement;
    confirm.click();
    expect(onForceRestore).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("a non-overridable halt (start-failed) offers no escape hatch at all", () => {
    const el = mountEl({});
    el.renderState({ view: "halted", reason: "start-failed", message: "Start failed" });
    expect(sr(el).querySelector("button.link-btn")).toBeNull();
  });
});

describe("<libre-wallet> approval modal", () => {
  // The sheet is a top-layer <dialog> so a host's own modal can never cover it (element.ts
  // requestApproval). jsdom implements no <dialog>, so open/close here come from the shim in
  // src/test-setup.ts; the markup, the handlers, and every promise-settling path are the real ones.
  it("approves with a parsed cap", async () => {
    const el = mountEl();
    const p = el.requestApproval({ kind: "enable", origin: "https://host.example" });
    const overlay = sr(el).querySelector(".overlay")! as HTMLDialogElement;
    expect(overlay.open).toBe(true);
    expect(overlay.textContent).toContain("host.example");
    (overlay.querySelector("input.field") as HTMLInputElement).value = "5000";
    (overlay.querySelector("button.primary") as HTMLButtonElement).click();
    await expect(p).resolves.toEqual({ granted: true, limitSats: 5000 });
    expect(overlay.open).toBe(false);
  });

  it("rejects garbage cap input inline (strict parse), approves unlimited only via the checkbox", async () => {
    const el = mountEl();
    const p = el.requestApproval({ kind: "raise-cap", origin: "https://host.example", amountSats: 800, currentLimitSats: 500 });
    const overlay = sr(el).querySelector(".overlay")! as HTMLDialogElement;
    (overlay.querySelector("input.field") as HTMLInputElement).value = "1,000"; // strict parse must reject
    (overlay.querySelector("button.primary") as HTMLButtonElement).click();
    expect(overlay.open).toBe(true); // still open, error shown
    expect((overlay.querySelector(".msg.bad") as HTMLElement).hidden).toBe(false);
    (overlay.querySelector('input[type="checkbox"]') as HTMLInputElement).checked = true;
    (overlay.querySelector("button.primary") as HTMLButtonElement).click();
    await expect(p).resolves.toEqual({ granted: true, limitSats: null });
  });

  it("cancel resolves ungranted", async () => {
    const el = mountEl();
    const p = el.requestApproval({ kind: "enable", origin: "https://host.example" });
    (sr(el).querySelector(".overlay button.secondary") as HTMLButtonElement).click();
    await expect(p).resolves.toEqual({ granted: false });
  });

  // showModal() gives the sheet a native dismissal the buttons don't mediate. The caller is
  // awaiting a decision that only a click produces, so an Esc that closed the dialog without
  // settling would hang the payment exactly like the in-card overlay it replaced.
  it("Esc dismissal resolves ungranted rather than hanging the caller", async () => {
    const el = mountEl();
    const p = el.requestApproval({ kind: "enable", origin: "https://host.example" });
    const overlay = sr(el).querySelector(".overlay")! as HTMLDialogElement;
    expect(overlay.open).toBe(true);
    overlay.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toEqual({ granted: false });
    expect(overlay.open).toBe(false);
  });

  // Every exit settles exactly once — a second close must not try to re-resolve.
  it("closing twice is harmless", async () => {
    const el = mountEl();
    const p = el.requestApproval({ kind: "enable", origin: "https://host.example" });
    const overlay = sr(el).querySelector(".overlay")! as HTMLDialogElement;
    (overlay.querySelector("button.secondary") as HTMLButtonElement).click();
    overlay.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toEqual({ granted: false });
  });
});
