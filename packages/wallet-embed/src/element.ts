// The <libre-wallet> custom element: a compact, login-only connector card. It renders the
// RoamingViewState machine (connect → restore → running / blocked / halted / paused) inside a
// shadow root, and hosts the spend-approval modal the WebLN provider awaits. All dynamic text is
// set via textContent (never innerHTML) — the static skeleton is the only markup literal.

import { parseCapInput, type RoamingViewState } from "@libre/wallet-core";
import type { ApprovalDecision, ApprovalRequest } from "./provider";
import { EMBED_CSS } from "./styles";

export interface ElementHooks {
  onConnect(): void; // Drive sign-in + session.boot()
  onSubmitSecret(secret: string): void;
  onMoveHere(): void;
  onRetry(): void; // paused / halted / moved-away → try boot again
  onDisconnect(): void;
  walletAppUrl: string;
  appName?: string;
}

export class LibreWalletElement extends HTMLElement {
  private root: ShadowRoot;
  private bodyEl!: HTMLElement;
  private netEl!: HTMLElement;
  private overlayEl!: HTMLDialogElement;
  private hooks?: ElementHooks;
  private lastState: RoamingViewState = { view: "checking" };
  private balanceText = "— sats";

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = EMBED_CSS;
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="head">
        <div class="mark">⚡</div>
        <div class="title">Libre Wallet</div>
        <div class="net" data-ref="net"></div>
      </div>
      <div class="body" data-ref="body"></div>
      <dialog class="overlay" data-ref="overlay"></dialog>
    `;
    this.root.append(style, card);
    this.bodyEl = card.querySelector('[data-ref="body"]')!;
    this.netEl = card.querySelector('[data-ref="net"]')!;
    this.overlayEl = card.querySelector('[data-ref="overlay"]')!;
  }

  wire(hooks: ElementHooks): void {
    this.hooks = hooks;
  }

  setNetwork(network: string): void {
    this.netEl.textContent = network === "mainnet" ? "" : network;
  }

  setBalance(text: string): void {
    this.balanceText = text;
    if (this.lastState.view === "running") this.renderState(this.lastState);
  }

  /** Render a roaming view state. Called by the mount glue on every session transition. */
  renderState(state: RoamingViewState): void {
    this.lastState = state;
    const b = this.bodyEl;
    b.textContent = "";
    const add = <T extends HTMLElement>(el: T): T => (b.appendChild(el), el);
    const msg = (text: string, cls = "msg") => {
      const p = document.createElement("p");
      p.className = cls;
      p.textContent = text;
      return add(p);
    };
    const button = (label: string, cls: "primary" | "secondary", onClick: () => void) => {
      const btn = document.createElement("button");
      btn.className = cls;
      btn.textContent = label;
      btn.addEventListener("click", () => {
        btn.disabled = true; // single-flight: re-render re-enables (guardedClick rule)
        onClick();
      });
      return add(btn);
    };
    const spinRow = (text: string) => {
      const row = document.createElement("div");
      row.className = "row";
      const s = document.createElement("div");
      s.className = "spin";
      const t = document.createElement("span");
      t.className = "msg";
      t.textContent = text;
      row.append(s, t);
      return add(row);
    };
    const walletAppLink = (label: string) => {
      const a = document.createElement("a");
      a.className = "link";
      a.href = this.hooks?.walletAppUrl ?? "#";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = label;
      return add(a);
    };

    switch (state.view) {
      case "checking":
        spinRow("Checking your wallet…");
        break;
      case "blocked":
        msg(`Your wallet is active on ${hostOf(state.origin)}.`);
        button("Move wallet here", "primary", () => this.hooks?.onMoveHere());
        break;
      case "need-secret": {
        msg("Wallet backup found. Enter your recovery phrase or seed to use it here (asked once per site).");
        const input = document.createElement("input");
        input.className = "field";
        input.type = "password";
        input.placeholder = "24 words or 64-hex seed";
        input.autocomplete = "off";
        add(input);
        button("Unlock wallet", "primary", () => this.hooks?.onSubmitSecret(input.value.trim()));
        break;
      }
      case "setup-needed":
        msg("No Libre Wallet found for this account yet.");
        walletAppLink("Set up your wallet first →");
        break;
      case "moving":
        spinRow("Moving your wallet here — waiting for the other site to finish saving…");
        break;
      case "starting":
        spinRow("Starting your node…");
        break;
      case "running": {
        const row = document.createElement("div");
        row.className = "row";
        const dot = document.createElement("div");
        dot.className = "dot";
        const bal = document.createElement("div");
        bal.className = "balance";
        bal.textContent = this.balanceText;
        row.append(dot, bal);
        add(row);
        const actions = document.createElement("div");
        actions.className = "actions";
        const open = document.createElement("a");
        open.className = "link";
        open.href = this.hooks?.walletAppUrl ?? "#";
        open.target = "_blank";
        open.rel = "noopener";
        open.textContent = "Open wallet app";
        const dis = document.createElement("button");
        dis.className = "secondary";
        dis.textContent = "Disconnect";
        dis.addEventListener("click", () => this.hooks?.onDisconnect());
        actions.append(open, dis);
        add(actions);
        break;
      }
      case "moved-away":
        msg(`Your wallet moved to ${hostOf(state.origin)}.`);
        button("Move it back here", "primary", () => this.hooks?.onRetry());
        break;
      case "halted":
        msg(state.message, "msg warn");
        button("Try again", "secondary", () => this.hooks?.onRetry());
        break;
      case "paused":
        msg("Can't reach Google Drive — the wallet is paused to stay safe.", "msg warn");
        button("Retry", "secondary", () => this.hooks?.onRetry());
        break;
      case "stopped":
        msg("Wallet disconnected from this site.");
        button("Connect Libre Wallet", "primary", () => this.hooks?.onConnect());
        break;
    }
  }

  /** The disconnected entry view (before any session exists / Drive not connected). */
  renderConnect(): void {
    this.lastState = { view: "stopped" };
    this.bodyEl.textContent = "";
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "Connect Libre Wallet";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      this.hooks?.onConnect();
    });
    const hint = document.createElement("p");
    hint.className = "fineprint";
    hint.textContent = "Signs into Google Drive and brings your wallet to this site while you use it.";
    const a = document.createElement("a");
    a.className = "link";
    a.href = this.hooks?.walletAppUrl ?? "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Don't have a wallet yet? Set one up →";
    this.bodyEl.append(btn, hint, a);
  }

  /**
   * Spend/enable approval modal. Resolves the provider's requestApproval.
   *
   * MUST be a <dialog>.showModal(), never an in-card overlay: this promise only settles from a
   * click below, so anything that makes the sheet unclickable hangs the host's payment forever
   * (no reject, no timeout). Hosts embed this card in their own stacking context — boostmebitch
   * docks it at z-30 and opens its boost modal at z-60 — and a descendant's z-index cannot escape
   * an ancestor's stacking context, so no z-index we choose here can win. showModal() puts the
   * sheet in the browser's top layer, which is above every stacking context by construction.
   * (Caveat inherent to the top layer: a display:none ancestor still renders nothing.)
   */
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const o = this.overlayEl;
      o.textContent = "";
      o.showModal();
      const sheet = document.createElement("div");
      sheet.className = "sheet";
      const h = document.createElement("h3");
      const p = document.createElement("p");
      p.className = "msg";
      if (req.kind === "enable") {
        h.textContent = `Connect to ${hostOf(req.origin)}?`;
        p.textContent = "This site will be able to request payments from your wallet, up to the daily limit you set.";
      } else {
        h.textContent = "Daily limit reached";
        p.textContent =
          `A payment of ${req.amountSats ?? 0} sats would exceed today's limit` +
          (req.currentLimitSats ? ` of ${req.currentLimitSats} sats` : "") +
          ". Raise the limit to continue?";
      }
      const input = document.createElement("input");
      input.className = "field";
      input.type = "text";
      input.inputMode = "numeric";
      input.placeholder = "Daily limit (sats)";
      const check = document.createElement("label");
      check.className = "check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      check.append(cb, document.createTextNode("No limit (not recommended)"));
      const err = document.createElement("p");
      err.className = "msg bad";
      err.hidden = true;
      const actions = document.createElement("div");
      actions.className = "actions";
      const cancel = document.createElement("button");
      cancel.className = "secondary";
      cancel.textContent = "Cancel";
      const ok = document.createElement("button");
      ok.className = "primary";
      ok.textContent = req.kind === "enable" ? "Connect" : "Approve";
      actions.append(cancel, ok);
      sheet.append(h, p, input, check, err, actions);
      o.appendChild(sheet);

      // Closing the dialog is the ONLY way this settles, so every exit routes through it — including
      // Esc, a native dismissal showModal() adds that the buttons never see. Denial is the default,
      // so an Esc (or any future close we don't write ourselves) can't strand the caller awaiting a
      // decision that never comes. `close` fires once per dialog, so `{ once: true }` is the
      // settle-exactly-once guarantee — no latch needed.
      let decision: ApprovalDecision = { granted: false };
      o.addEventListener(
        "close",
        () => {
          o.textContent = "";
          resolve(decision);
        },
        { once: true },
      );
      const settle = (d: ApprovalDecision) => {
        decision = d;
        o.close();
      };
      cancel.addEventListener("click", () => o.close());
      ok.addEventListener("click", () => {
        if (cb.checked) return settle({ granted: true, limitSats: null });
        const parsed = parseCapInput(input.value);
        if (!parsed.ok) {
          err.textContent = "Enter a whole number of sats, or tick “No limit”.";
          err.hidden = false;
          return;
        }
        settle({ granted: true, limitSats: parsed.sats });
      });
    });
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export const ELEMENT_TAG = "libre-wallet";

/** Idempotent element registration (guarded — safe to call from several bundles). */
export function registerLibreWallet(): void {
  if (typeof customElements === "undefined") return; // SSR — a later client mount registers it
  if (!customElements.get(ELEMENT_TAG)) customElements.define(ELEMENT_TAG, LibreWalletElement);
}
