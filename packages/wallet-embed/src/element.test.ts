import { describe, it, expect, vi, beforeAll } from "vitest";
import { ELEMENT_TAG, LibreWalletElement, registerLibreWallet } from "./element";
import type { ElementHooks } from "./element";

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
});

describe("<libre-wallet> approval modal", () => {
  it("approves with a parsed cap", async () => {
    const el = mountEl();
    const p = el.requestApproval({ kind: "enable", origin: "https://host.example" });
    const overlay = sr(el).querySelector(".overlay")! as HTMLElement;
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toContain("host.example");
    (overlay.querySelector("input.field") as HTMLInputElement).value = "5000";
    (overlay.querySelector("button.primary") as HTMLButtonElement).click();
    await expect(p).resolves.toEqual({ granted: true, limitSats: 5000 });
    expect(overlay.hidden).toBe(true);
  });

  it("rejects garbage cap input inline (strict parse), approves unlimited only via the checkbox", async () => {
    const el = mountEl();
    const p = el.requestApproval({ kind: "raise-cap", origin: "https://host.example", amountSats: 800, currentLimitSats: 500 });
    const overlay = sr(el).querySelector(".overlay")! as HTMLElement;
    (overlay.querySelector("input.field") as HTMLInputElement).value = "1,000"; // strict parse must reject
    (overlay.querySelector("button.primary") as HTMLButtonElement).click();
    expect(overlay.hidden).toBe(false); // still open, error shown
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
});
