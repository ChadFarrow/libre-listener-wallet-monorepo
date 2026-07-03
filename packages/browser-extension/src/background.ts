import { MSG, newId, type RpcResponse } from "./core/messages";
import { PermissionStore } from "./core/permission-store";
import { chromeKV } from "./core/chrome-kv";
import { normalizeSendPayment, spendAmountSats } from "./core/webln-mapping";
import { isAllowedWeblnMethod } from "./core/webln-gate";
import { isFromExtensionContext } from "./core/sender-guard";
import { invoiceAmountSats } from "./core/bolt11-amount";
import { isSettlementPending } from "./core/settlement-pending";
import { buildAuthUrl, parseTokenFromRedirect } from "./core/drive-oauth";
import {
  uploadBackup,
  downloadBackup,
  listBackupNetworks,
  pickRestoreNetwork,
  fetchAccountEmail,
} from "./core/drive-rest";
import { AUTO_START_KEY, isAutoStartEnabled } from "./core/auto-start";

// The background service worker is a THIN, restartable router + permission gate. It never hosts
// the node (that's the offscreen document) — it can be killed at ~30s idle and respawn without
// losing wallet state. Two jobs:
//   1. Ensure the offscreen document exists and relay RPC to it.
//   2. Gate WebLN requests from pages: per-origin enable() approval + spending caps.

const store = new PermissionStore(chromeKV);

// ---- Offscreen lifecycle (idempotent) ----

let creating: Promise<unknown> | null = null;
async function ensureOffscreen(): Promise<void> {
  // hasDocument exists in Chrome 116+ (optional-chained for older runtimes)
  if (await chrome.offscreen.hasDocument?.()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Runs the Lightning (LDK) node: WASM, the WebSocket peer connection, and background sync timers.",
      })
      .then(() => {
        // The document was just created — kick auto-start. One hook covers EVERY creation path
        // (onStartup, onInstalled, a popup command, a WebLN request). The flag is read HERE
        // because offscreen documents only get chrome.runtime — chrome.storage is undefined
        // there (reading it in the offscreen host silently killed auto-start; pinned by
        // offscreen/runtime-only-apis.test.ts). Fire-and-forget: auto-start must never delay
        // the RPC that triggered the creation.
        void triggerAutoStart().catch((e: any) => console.warn("[AutoStart] trigger failed:", e?.message || e));
      })
      .catch((e: unknown) => {
        // A concurrent caller may have created it first.
        if (!String(e).includes("single offscreen")) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

// Read the persisted auto_start flag on the offscreen document's behalf and hand it over. The
// document is guaranteed to exist here (called from ensureOffscreen's creation path), so this
// sends directly rather than re-entering ensureOffscreen.
async function triggerAutoStart(): Promise<void> {
  const flagRaw = await chromeKV.get(AUTO_START_KEY);
  const resp: RpcResponse = await chrome.runtime.sendMessage({
    kind: MSG.WALLET_RPC,
    id: newId(),
    method: "autoStart",
    params: { flagRaw },
  });
  if (resp && !resp.ok) throw new Error(resp.error || "autoStart RPC failed");
}

// ---- Auto-start ----
//
// Bring the wallet up on browser launch and extension install/update: ensureOffscreen()'s
// creation hook fires the autoStart RPC into the freshly created document.
chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen().catch((e: any) => console.warn("[AutoStart] ensureOffscreen failed:", e?.message || e));
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen().catch((e: any) => console.warn("[AutoStart] ensureOffscreen failed:", e?.message || e));
});

async function callOffscreen(method: string, params?: any): Promise<any> {
  await ensureOffscreen();
  const id = newId();
  const resp: RpcResponse = await chrome.runtime.sendMessage({ kind: MSG.WALLET_RPC, id, method, params });
  if (!resp) throw new Error("No response from wallet host");
  if (!resp.ok) throw new Error(resp.error || "Wallet host error");
  return resp.result;
}

// ---- Google Drive backup ----
//
// The OAuth token flow (chrome.identity) and the Drive REST calls live here in the background;
// the ENCRYPTED backup envelope is produced by the offscreen wallet host (`exportBackup`), so the
// raw seed never reaches this context — only the ciphertext is uploaded (key-isolation guardrail).
// The access token is short-lived and held in memory only (the SW may be killed; we re-auth).

// The OAuth client ID is a GLOBAL, network-agnostic extension setting (not per-wallet config), so
// it lives in chrome.storage.local and can be set without stopping the node.
const DRIVE_EMAIL_KEY = "drive_account_email";
const GOOGLE_CLIENT_ID_KEY = "google_client_id";
let driveToken: { value: string; expiresAt: number } | null = null;

function driveConnected(): boolean {
  return !!driveToken && driveToken.expiresAt > Date.now();
}

async function acquireDriveToken(interactive: boolean): Promise<string> {
  const clientId = await chromeKV.get(GOOGLE_CLIENT_ID_KEY);
  if (!clientId) throw new Error("Set your Google OAuth Client ID in the extension's settings first.");
  const redirectUri = chrome.identity.getRedirectURL();
  const hint = (await chromeKV.get(DRIVE_EMAIL_KEY)) || undefined;
  const authUrl = buildAuthUrl(clientId, redirectUri, {
    hint,
    // Silent reconnect reuses an existing Google session without UI; interactive shows consent.
    prompt: interactive ? undefined : "none",
  });
  const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive });
  const { accessToken, expiresInSec } = parseTokenFromRedirect(redirect || undefined);
  // Expire a minute early so a call never races the real expiry.
  driveToken = { value: accessToken, expiresAt: Date.now() + (expiresInSec - 60) * 1000 };
  void fetchAccountEmail(accessToken).then((email) => {
    if (email) void chromeKV.set(DRIVE_EMAIL_KEY, email);
  });
  return accessToken;
}

async function ensureDriveToken(): Promise<string> {
  if (driveConnected()) return driveToken!.value;
  // Try a silent reconnect against an existing Google session before surfacing an error.
  return acquireDriveToken(false);
}

async function driveConnect(): Promise<{ email: string | null }> {
  await acquireDriveToken(true);
  return { email: (await chromeKV.get(DRIVE_EMAIL_KEY)) ?? null };
}

async function driveStatus(): Promise<{ connected: boolean; email: string | null }> {
  return { connected: driveConnected(), email: (await chromeKV.get(DRIVE_EMAIL_KEY)) ?? null };
}

function driveDisconnect(): { connected: boolean } {
  driveToken = null;
  return { connected: false };
}

async function driveBackupNow(): Promise<{ network: string }> {
  const token = await ensureDriveToken();
  const envelope: string = await callOffscreen("exportBackup");
  const state = await callOffscreen("getState");
  await uploadBackup(token, envelope, state.network);
  return { network: state.network };
}

async function driveRestore(secret: string): Promise<any> {
  if (!secret) throw new Error("Enter your recovery seed to restore from Drive.");
  const token = await ensureDriveToken();
  const networks = await listBackupNetworks(token);
  const network = pickRestoreNetwork(networks);
  if (!network) throw new Error("No backup found in this Google account.");
  const envelope = await downloadBackup(token, network);
  if (!envelope) throw new Error("Backup file could not be downloaded.");
  return callOffscreen("restoreWallet", { envelope, secret });
}

// ---- Auto-download backup (no cloud) ----
//
// When enabled, a fresh encrypted backup file is saved to Downloads whenever the wallet's state
// advances — coalesced (trailing debounce) so a burst of activity produces one file, not dozens.
// A service worker can't create Blob URLs, so the offscreen document mints one and we hand it to
// chrome.downloads. Zero setup (no Google), off by default.
const AUTO_DOWNLOAD_KEY = "auto_download_backup";
// It overwrites ONE rolling file, so keeping it current is cheap on file count — debounce just long
// enough to coalesce a burst of state changes into one write, so the saved copy is essentially
// always up to date (minimizing the "restore behind → force-close" window).
const AUTO_DOWNLOAD_DEBOUNCE_MS = 8_000;
let autoDownloadTimer: ReturnType<typeof setTimeout> | null = null;

async function autoDownloadBackup(): Promise<void> {
  const { url, filename } = await callOffscreen("exportBackupBlob");
  const id = await chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false });
  // Keep chrome://downloads tidy: erase the history record once the file is written (the file stays).
  if (typeof id === "number") {
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === id && delta.state?.current === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged);
        void chrome.downloads.erase({ id }).catch(() => {});
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  }
}

function scheduleAutoDownload(): void {
  void chromeKV.get(AUTO_DOWNLOAD_KEY).then((enabled) => {
    if (enabled !== "1") return;
    if (autoDownloadTimer) clearTimeout(autoDownloadTimer);
    autoDownloadTimer = setTimeout(() => {
      autoDownloadTimer = null;
      void autoDownloadBackup().catch((e) => console.warn("[Backup] auto-download failed:", e?.message || e));
    }, AUTO_DOWNLOAD_DEBOUNCE_MS);
  });
}

// Auto-sync: when the wallet's persisted state advances (a channel opened, a payment settled),
// push a fresh encrypted backup, debounced. Drive sync mirrors the PWA (restorability prioritized
// over write count); the local auto-download is the no-cloud alternative. Both are best-effort.
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
chrome.runtime.onMessage.addListener((msg, sender) => {
  // Defense-in-depth: only our own contexts (the offscreen host) emit wallet events. A content
  // script's sender.url is the web page, so this rejects any page-originated forgery — matching the
  // sender gating on every other message kind.
  if (!isFromExtensionContext(sender, chrome.runtime.id, chrome.runtime.getURL(""))) return false;
  if (msg?.kind === MSG.WALLET_EVENT && msg.event === "state-changed") {
    if (driveConnected()) {
      if (autoSyncTimer) clearTimeout(autoSyncTimer);
      autoSyncTimer = setTimeout(() => {
        autoSyncTimer = null;
        void driveBackupNow().catch((e) => console.warn("[Drive] auto-sync failed:", e?.message || e));
      }, 5000);
    }
    scheduleAutoDownload();
  }
  return false; // never the responder for events
});

// ---- Approval prompts ----

interface PendingApproval {
  origin: string;
  resolve: (d: { approved: boolean; spendingLimitSats: number }) => void;
  promise: Promise<{ approved: boolean; spendingLimitSats: number }>;
  windowId?: number;
}
const pendingApprovals = new Map<string, PendingApproval>();

async function requestApproval(origin: string): Promise<{ approved: boolean; spendingLimitSats: number }> {
  // Coalesce concurrent prompts for the same origin. Without this, a hostile page
  // calling webln.enable() in a loop spawns one focused OS popup per call — a
  // window bomb that buries the browser and can socially-engineer an errant
  // Approve. Reuse the in-flight prompt's promise instead.
  for (const p of pendingApprovals.values()) {
    if (p.origin === origin) return p.promise;
  }

  const id = newId();
  const url = chrome.runtime.getURL(`approval.html?origin=${encodeURIComponent(origin)}&id=${id}`);
  let resolveFn!: (d: { approved: boolean; spendingLimitSats: number }) => void;
  const decision = new Promise<{ approved: boolean; spendingLimitSats: number }>((resolve) => {
    resolveFn = resolve;
  });
  pendingApprovals.set(id, { origin, resolve: resolveFn, promise: decision });
  const win = await chrome.windows.create({ url, type: "popup", width: 400, height: 560, focused: true });
  const p = pendingApprovals.get(id);
  if (p) p.windowId = win?.id;
  return decision;
}

// A closed approval window with no decision counts as a denial.
chrome.windows.onRemoved.addListener((closedId) => {
  for (const [id, p] of pendingApprovals) {
    if (p.windowId === closedId) {
      pendingApprovals.delete(id);
      p.resolve({ approved: false, spendingLimitSats: 0 });
    }
  }
});

async function ensureEnabled(origin: string): Promise<void> {
  if (await store.isEnabled(origin)) return;
  const decision = await requestApproval(origin);
  if (!decision.approved) throw new Error(`User denied wallet access for ${origin}`);
  // The grant is persisted by the APPROVAL_DECISION handler before it resolves this promise, so the
  // approval survives an SW restart mid-prompt. Nothing more to do here.
}

// ---- WebLN permission gate ----

async function handleWebln(origin: string, method: string, params: any): Promise<any> {
  // Trust boundary: a page may ONLY invoke the WebLN provider surface. Never forward an arbitrary
  // page-supplied method to the offscreen host — that would expose control-plane RPC (exportBackup,
  // createWallet, nwcCreateConnection, …) to any enabled origin.
  if (!isAllowedWeblnMethod(method)) {
    throw new Error(`WebLN method not permitted: ${method}`);
  }

  if (method === "enable") {
    await ensureEnabled(origin);
    return {};
  }
  if (method === "isEnabled") {
    return await store.isEnabled(origin);
  }
  if (!(await store.isEnabled(origin))) {
    throw new Error("Wallet access not granted for this site. Call webln.enable() first.");
  }

  if (method === "sendPayment") {
    // Decode the invoice amount for the cap check (the background is the ONLY cap enforcer — the
    // offscreen host does not check caps). Fail CLOSED: if we can't read the amount, refuse to pay
    // rather than let an undecodable invoice slip past the daily cap.
    const bolt11 = normalizeSendPayment(params);
    const amt = safeInvoiceAmount(bolt11);
    if (amt == null) {
      throw new Error("Could not read the invoice amount to check the spending cap; refusing to pay.");
    }
    await store.chargeIfWithinCap(origin, amt);
    try {
      return await callOffscreen("sendPayment", params);
    } catch (e) {
      // Refund only on a pre-initiation failure. A settlement timeout means send_payment is still
      // in flight (Retry attempts) and likely settles — keeping the charge is the safe accounting.
      if (!isSettlementPending((e as Error)?.message)) await store.refund(origin, amt);
      throw e;
    }
  }

  if (method === "keysend") {
    const amt = spendAmountSats("keysend", params);
    await store.chargeIfWithinCap(origin, amt);
    try {
      return await callOffscreen("keysend", params);
    } catch (e) {
      if (!isSettlementPending((e as Error)?.message)) await store.refund(origin, amt);
      throw e;
    }
  }

  // Read-only after enable: getInfo, makeInvoice (the allowlist above bounds this to those two).
  return await callOffscreen(method, params);
}

function safeInvoiceAmount(bolt11: string): number | null {
  try {
    return invoiceAmountSats(bolt11);
  } catch {
    return null;
  }
}

// ---- Router ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p: Promise<any>) =>
    void p.then(
      (result) => sendResponse({ id: msg?.id, ok: true, result } as RpcResponse),
      (err) => sendResponse({ id: msg?.id, ok: false, error: err?.message || String(err) } as RpcResponse)
    );

  // Every message must come from our own extension. The privileged control-plane (WALLET_COMMAND,
  // APPROVAL_DECISION) additionally must come from one of our own pages (popup/options/approval) —
  // identified by a chrome-extension:// url, NOT by the absence of a tab (the approval window and
  // the options page are tab-hosted). This blocks a content script — whose url is the web page —
  // from driving control-plane commands or forging an approval decision. WEBLN_REQUEST legitimately
  // comes from a content script (it carries the stamped origin and is subject to the permission gate).
  const fromExtension = sender?.id === chrome.runtime.id;
  const fromExtensionPage = isFromExtensionContext(sender, chrome.runtime.id, chrome.runtime.getURL(""));
  if ((msg?.kind === MSG.WALLET_COMMAND || msg?.kind === MSG.APPROVAL_DECISION) && !fromExtensionPage) {
    // Diagnostic: show exactly what sender was rejected so a legit extension page isn't blocked.
    console.warn("[Router] rejected privileged msg", msg?.kind, "sender:", { id: sender?.id, url: sender?.url, hasTab: !!sender?.tab });
  }

  switch (msg?.kind) {
    case MSG.WEBLN_REQUEST:
      if (!fromExtension) {
        sendResponse({ id: msg?.id, ok: false, error: "Unauthorized sender" } as RpcResponse);
        return true;
      }
      // Origin is stamped by the content-script (trusted), never taken from the page.
      reply(handleWebln(msg.origin, msg.method, msg.params));
      return true;

    case MSG.WALLET_COMMAND:
      if (!fromExtensionPage) {
        sendResponse({ id: msg?.id, ok: false, error: "Unauthorized sender" } as RpcResponse);
        return true;
      }
      // Trusted control-plane from popup/options. Permission commands are owned by the background
      // (the permission store lives here); everything else forwards to the offscreen host.
      if (msg.command === "listGrants") {
        reply(store.listGrants());
      } else if (msg.command === "revokeGrant") {
        reply(store.revoke(msg.params.origin));
      } else if (msg.command === "setGrantLimit") {
        reply(store.grant(msg.params.origin, { spendingLimitSats: Number(msg.params.spendingLimitSats) || 0 }));
      } else if (msg.command === "driveConnect") {
        reply(driveConnect());
      } else if (msg.command === "driveStatus") {
        reply(driveStatus());
      } else if (msg.command === "driveDisconnect") {
        reply(Promise.resolve(driveDisconnect()));
      } else if (msg.command === "driveBackupNow") {
        reply(driveBackupNow());
      } else if (msg.command === "driveRestore") {
        reply(driveRestore(msg.params?.secret));
      } else if (msg.command === "driveRedirectUri") {
        reply(Promise.resolve(chrome.identity.getRedirectURL()));
      } else if (msg.command === "getGoogleClientId") {
        reply(chromeKV.get(GOOGLE_CLIENT_ID_KEY));
      } else if (msg.command === "setGoogleClientId") {
        reply(chromeKV.set(GOOGLE_CLIENT_ID_KEY, String(msg.params?.clientId || "")));
      } else if (msg.command === "getAutoDownload") {
        reply(chromeKV.get(AUTO_DOWNLOAD_KEY).then((v) => v === "1"));
      } else if (msg.command === "setAutoDownload") {
        reply(chromeKV.set(AUTO_DOWNLOAD_KEY, msg.params?.enabled ? "1" : ""));
      } else if (msg.command === "getAutoStart") {
        reply(chromeKV.get(AUTO_START_KEY).then(isAutoStartEnabled));
      } else if (msg.command === "setAutoStart") {
        reply(chromeKV.set(AUTO_START_KEY, msg.params?.enabled ? "1" : "0"));
      } else {
        reply(callOffscreen(msg.command, msg.params));
      }
      return true;

    case MSG.APPROVAL_DECISION: {
      if (!fromExtensionPage) {
        sendResponse({ id: msg?.id, ok: false, error: "Unauthorized sender" } as RpcResponse);
        return true;
      }
      const approved = !!msg.approved;
      const spendingLimitSats = Number(msg.spendingLimitSats) || 0;
      // Persist the grant HERE (not only in the enable() promise): the MV3 SW can be reaped while
      // the approval window is open, dropping the in-memory pending promise. Granting on the
      // decision makes the approval durable — a retry of enable() then finds the grant. Requires
      // the approval page to send its origin.
      const finish = async () => {
        if (approved && msg.origin) await store.grant(msg.origin, { spendingLimitSats });
        const p = pendingApprovals.get(msg.id);
        if (p) {
          pendingApprovals.delete(msg.id);
          p.resolve({ approved, spendingLimitSats });
        }
      };
      reply(finish());
      return true;
    }

    default:
      return false; // not ours (e.g. WALLET_RPC handled by offscreen, WALLET_EVENT by popup)
  }
});
