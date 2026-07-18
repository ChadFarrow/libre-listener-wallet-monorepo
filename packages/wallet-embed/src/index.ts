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
import { makeTransactionFeed, toTxViews, type TxView } from "./transactions";

export { registerLibreWallet, ELEMENT_TAG } from "./element";
export { createWeblnProvider, installWebln } from "./provider";
export type { LibreWeblnProvider, ApprovalRequest, ApprovalDecision } from "./provider";
export type { TxView } from "./transactions";
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
  /**
   * Whether `installWebln` actually took window.webln. False when it was left alone because another
   * provider (e.g. Alby) already held it — in that case window.webln is NOT this wallet, and a host
   * that pays through it would silently charge the other one. Always pay via `webln` above.
   */
  installedWebln: boolean;
  element: HTMLElement;
  /** Current roaming view (running / blocked / …) — the host can reflect connection state. */
  state(): RoamingViewState;
  onState(cb: (s: RoamingViewState) => void): () => void;
  /**
   * The wallet's unified payment log (every app paying through this wallet shares it), newest-first,
   * as display views (no preimage). Read-only, moves no funds. Works even with the node stopped
   * (reads persisted history), and reflects whatever roamed in from the Drive backup. Render it
   * however the host wants — the embed draws no history UI itself.
   */
  getTransactions(): Promise<TxView[]>;
  /**
   * Fire `cb` whenever a payment newly SETTLES (not for pre-existing history — read that with
   * getTransactions), so a host feed updates live without polling. Returns an unsubscribe fn.
   */
  onTransaction(cb: (tx: TxView) => void): () => void;
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
  const txListeners = new Set<(tx: TxView) => void>();
  const txFeed = makeTransactionFeed();
  let balanceTimer: ReturnType<typeof setInterval> | undefined;

  const refreshBalance = async () => {
    try {
      const s = await embed.controller.getState();
      if (s.running && s.balance) element.setBalance(`${s.balance.spendableSat.toLocaleString()} sats`);
    } catch {
      /* balance readout is cosmetic */
    }
  };

  // On every controller event (settlements persist state → an event fires), diff the log and hand
  // any newly-settled payment to host subscribers. The feed baselines existing history on its first
  // run, so pre-existing records never re-fire. Runs regardless of listener count so `seen` stays
  // current and a late subscriber isn't flooded with backlog (it reads that via getTransactions).
  const dispatchNewTransactions = async () => {
    try {
      const fresh = txFeed.ingest(await embed.controller.getPayments());
      for (const tx of fresh) {
        for (const cb of txListeners) {
          try {
            cb(tx);
          } catch {
            /* a throwing host subscriber must never break the others or a payment path */
          }
        }
      }
    } catch {
      /* history is non-critical */
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
    onControllerEvent: () => {
      void refreshBalance();
      void dispatchNewTransactions();
    },
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
    onForceRestore: () => void embed.session.forceRestoreAnyway(),
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

  // Closing down cleanly is what makes roaming work: a successor may only take the wallet over if
  // it can PROVE this origin's final state reached Drive, so an unrecorded close costs the user a
  // halt on their next device. Two hooks, because there is no single reliable "we're closing" event:
  //
  //  - visibilitychange → hidden fires while the page is still ALIVE and can await real work. On
  //    iOS it's what you get when the user switches apps or closes the browser, so this is the hook
  //    that actually runs in practice — and the only one that can flush the backup.
  //  - pagehide is the last resort, where nothing can be awaited: issue a synchronous keepalive
  //    lease write and hope. (The old code called an async exportBackup() here and believed the
  //    comment about keepalive surviving page death — but keepalive only protects a request already
  //    in flight, and this one was never issued. It was a no-op for the whole life of the widget.)
  const onHidden = () => {
    if (document.visibilityState === "hidden") void embed.closeSoon();
  };
  const onPageHide = () => {
    embed.releaseSync();
  };
  document.addEventListener("visibilitychange", onHidden);
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

  // Polite install: `false` means another provider (e.g. Alby) already owned window.webln and we
  // left it alone. The host MUST know — otherwise it sees a truthy window.webln, assumes it's us,
  // and routes payments to the other wallet under our name.
  const installedWebln = opts.installWebln ? installWebln(provider) : false;

  return {
    webln: provider,
    installedWebln,
    element,
    state: () => embed.session.current(),
    onState: (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    getTransactions: async () => toTxViews(await embed.controller.getPayments()),
    onTransaction: (cb) => {
      txListeners.add(cb);
      return () => txListeners.delete(cb);
    },
    async dispose() {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onHidden);
      if (balanceTimer !== undefined) clearInterval(balanceTimer);
      await embed.session.dispose();
      element.remove();
      // Leave no dead provider behind: a host that kept using window.webln after dispose would be
      // calling into a torn-down session. Only remove what we installed.
      if (installedWebln && (window as Window & { webln?: unknown }).webln === provider) {
        delete (window as Window & { webln?: unknown }).webln;
      }
    },
  };
}
