// @libre/wallet-embed — the "Connect Libre Wallet" login widget for the maintainer's own web
// apps. Hosts the LDK node IN-PAGE while the user is using the app (the iOS-backgrounding
// answer), with the wallet ROAMING between origins over the Drive backup + lease (wallet-core's
// roaming layer). Login-only: wallet creation/seed backup live in the standalone wallet PWA.
//
// SSR-SAFE BARREL: no top-level window/document/customElements access — a Next.js server import
// of this module is harmless; everything browser-bound happens inside mountLibreWallet().
//
// Trust model (README): shadow DOM is a style boundary, not a security boundary — the host page
// shares the origin (and IndexedDB) with the wallet. The approval modal + per-origin caps guard
// against host-app BUGS, not a hostile host. Embed only on origins you control.

import {
  DRIVE_HINT_KEY,
  beginDriveRedirect,
  completeDriveRedirect,
  connect as driveConnect,
  isConnected as driveIsConnected,
  isDriveConfiguredPersisted,
  type RoamingViewState,
} from "@libre/wallet-core";
import { ELEMENT_TAG, LibreWalletElement, registerLibreWallet } from "./element";
import { localStorageKV } from "./kv-localstorage";
import { createWeblnProvider, installWebln, type LibreWeblnProvider } from "./provider";
import { controllerRpc } from "./rpc-adapter";
import { createEmbedSession } from "./session-wiring";

export { registerLibreWallet, ELEMENT_TAG } from "./element";
export { createWeblnProvider, installWebln } from "./provider";
export type { LibreWeblnProvider, ApprovalRequest, ApprovalDecision } from "./provider";
export type { RoamingViewState } from "@libre/wallet-core";

const DEFAULT_WALLET_APP_URL = "https://libre-wallet-pwa.pages.dev";
const BALANCE_POLL_MS = 10_000;

export interface MountOptions {
  /** Google OAuth client id — REQUIRED (never read from env inside the lib). The mount origin
   *  must be registered on the client (Authorized JavaScript origins + redirect URIs). */
  googleClientId: string;
  /** Where liblightningjs.wasm is served from, e.g. "/liblightningjs.wasm". REQUIRED. */
  wasmUrl: string;
  network?: "mainnet" | "testnet" | "signet" | "regtest";
  /** Shown in the lease record + approval copy (e.g. "boostmebitch"). */
  appName?: string;
  /** Install the provider as window.webln (polite — never clobbers an existing provider). */
  installWebln?: boolean;
  /** Where "Set up your wallet first" sends new users. Defaults to the live wallet PWA. */
  walletAppUrl?: string;
}

export interface MountHandle {
  webln: LibreWeblnProvider;
  element: HTMLElement;
  /** Current roaming view (running / blocked / …) — the host can reflect connection state. */
  state(): RoamingViewState;
  onState(cb: (s: RoamingViewState) => void): () => void;
  dispose(): Promise<void>;
}

function isStandaloneDisplay(): boolean {
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

export function mountLibreWallet(target: HTMLElement | string, opts: MountOptions): MountHandle {
  if (typeof window === "undefined") {
    throw new Error("mountLibreWallet is browser-only — call it from a client-side effect.");
  }
  if (!opts.googleClientId) throw new Error("mountLibreWallet: googleClientId is required");
  if (!opts.wasmUrl) throw new Error("mountLibreWallet: wasmUrl is required");

  const host = typeof target === "string" ? document.querySelector<HTMLElement>(target) : target;
  if (!host) throw new Error(`mountLibreWallet: target not found: ${String(target)}`);

  registerLibreWallet();
  const element = document.createElement(ELEMENT_TAG) as LibreWalletElement;
  const network = opts.network ?? "mainnet";
  element.setNetwork(network);
  host.appendChild(element);

  const stateListeners = new Set<(s: RoamingViewState) => void>();
  let balanceTimer: ReturnType<typeof setInterval> | undefined;

  const refreshBalance = async () => {
    try {
      const s = await embed.controller.getState();
      if (s.running && s.balance) element.setBalance(`${s.balance.spendableSat.toLocaleString()} sats`);
    } catch {
      /* balance readout is cosmetic */
    }
  };

  const embed = createEmbedSession({
    network,
    wasmUrl: opts.wasmUrl,
    appName: opts.appName,
    onState: (s) => {
      element.renderState(s);
      for (const cb of stateListeners) cb(s);
      if (s.view === "running") {
        void refreshBalance();
        if (balanceTimer === undefined) balanceTimer = setInterval(() => void refreshBalance(), BALANCE_POLL_MS);
      } else if (balanceTimer !== undefined) {
        clearInterval(balanceTimer);
        balanceTimer = undefined;
      }
    },
    onControllerEvent: () => void refreshBalance(),
  });

  const provider = createWeblnProvider({
    rpc: controllerRpc(embed.controller),
    origin: location.origin,
    kv: localStorageKV(),
    requestApproval: (req) => element.requestApproval(req),
    isActive: () => embed.session.current().view === "running",
  });

  // Drive sign-in: GIS popup normally; installed-PWA standalone mode blocks popups → full-page
  // redirect (token returns in the URL fragment, which survives; picked up below on remount).
  const ensureDrive = async (): Promise<boolean> => {
    if (driveIsConnected()) return true;
    let hint: string | undefined;
    try {
      hint = localStorage.getItem(DRIVE_HINT_KEY) ?? undefined;
    } catch {
      hint = undefined;
    }
    if (isStandaloneDisplay()) {
      beginDriveRedirect(opts.googleClientId, hint); // navigates away
      return false;
    }
    await driveConnect(opts.googleClientId, { hint });
    return true;
  };

  element.wire({
    walletAppUrl: opts.walletAppUrl ?? DEFAULT_WALLET_APP_URL,
    appName: opts.appName,
    onConnect: () => {
      void (async () => {
        try {
          if (await ensureDrive()) await embed.session.boot();
          else element.renderConnect(); // redirect path navigates; re-enable if it didn't
        } catch (e) {
          console.warn("[libre-wallet] Drive connect failed:", (e as Error)?.message || e);
          element.renderConnect();
        }
      })();
    },
    onSubmitSecret: (secret) => void embed.session.submitSecret(secret),
    onMoveHere: () => void embed.session.moveHere(),
    onRetry: () => void embed.session.boot(),
    onDisconnect: () => void embed.session.dispose(),
  });

  // iOS-standalone OAuth return: capture the token fragment, then strip it (best-effort).
  const redirect = completeDriveRedirect(location.hash);
  if (redirect.ok || redirect.error) {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* best-effort fragment strip */
    }
  }

  // Emergency flush on page close/background: an issued keepalive upload survives page death;
  // a truly lost flush is caught by the crash-gap check on the next origin.
  const onPageHide = () => {
    if (embed.session.current().view === "running") embed.emergencyFlush();
  };
  window.addEventListener("pagehide", onPageHide);

  // Entry: connected (or just returned from the redirect) → boot straight away; configured but
  // token-expired → try a silent reconnect; otherwise wait for the user's Connect tap.
  void (async () => {
    if (driveIsConnected()) {
      await embed.session.boot();
      return;
    }
    if (isDriveConfiguredPersisted()) {
      let hint: string | undefined;
      try {
        hint = localStorage.getItem(DRIVE_HINT_KEY) ?? undefined;
      } catch {
        hint = undefined;
      }
      try {
        await driveConnect(opts.googleClientId, { silent: true, hint });
        await embed.session.boot();
        return;
      } catch {
        /* silent reconnect blocked (normal on iOS standalone) — fall through to the button */
      }
    }
    element.renderConnect();
  })();

  if (opts.installWebln) installWebln(provider);

  return {
    webln: provider,
    element,
    state: () => embed.session.current(),
    onState: (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    async dispose() {
      window.removeEventListener("pagehide", onPageHide);
      if (balanceTimer !== undefined) clearInterval(balanceTimer);
      await embed.session.dispose();
      element.remove();
    },
  };
}
