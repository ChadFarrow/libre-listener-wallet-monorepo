// Nostr Wallet Connect UI: create a pairing (URI + QR), copy it, and the
// active-pairings list with revoke. Exposes setNwcEnabled/updateNwcConnectionsList
// for the node start/stop handlers.
import QRCode from "qrcode";
import type { NwcMethod } from "@libre/shared";
import { appendLog } from "./core/logger";
import { copyToClipboard } from "./core/ui-helpers";
import type { AppContext } from "./core/app-context";
import {
  parseBudgetRenewal,
  parseMaxAmount,
  buildAllowedMethods,
  expiryFromDays,
  renewalLabel,
} from "@libre/shared";

const createNwcBtn = document.getElementById("create-nwc-btn") as HTMLButtonElement;
const nwcConnNameInput = document.getElementById("nwc-conn-name") as HTMLInputElement;
const nwcSpendingLimitInput = document.getElementById("nwc-spending-limit") as HTMLInputElement;
const nwcBudgetRenewalSelect = document.getElementById("nwc-budget-renewal") as HTMLSelectElement;
const nwcMaxAmountInput = document.getElementById("nwc-max-amount") as HTMLInputElement;
const nwcExpirySelect = document.getElementById("nwc-expiry") as HTMLSelectElement;
const nwcRelayUrlInput = document.getElementById("nwc-relay-url") as HTMLInputElement;
const nwcUriContainer = document.getElementById("nwc-uri-container") as HTMLDivElement;
const nwcUriStr = document.getElementById("nwc-uri-str") as HTMLTextAreaElement;
const copyNwcUriBtn = document.getElementById("copy-nwc-uri-btn") as HTMLButtonElement;
const nwcQrImg = document.getElementById("nwc-qr-img") as HTMLImageElement;
const nwcConnectionsList = document.getElementById("nwc-connections-list") as HTMLDivElement;

const EMPTY_LIST = '<div class="empty-list-text text-muted" style="font-size: 0.85rem;">No active pairings yet.</div>';

let ctx: AppContext;

export function initNwcUi(c: AppContext) {
  ctx = c;

  createNwcBtn.addEventListener("click", async () => {
    const wallet = ctx.getWallet();
    if (!wallet || !ctx.isRunning()) return;
    try {
      createNwcBtn.disabled = true;
      nwcUriContainer.classList.add("hidden");
      nwcQrImg.classList.add("hidden");

      const name = nwcConnNameInput.value.trim() || "Nostr Client App";
      const relayUrl = nwcRelayUrlInput.value.trim() || "wss://relay.getalby.com/v1";

      // Parse the spending cap strictly. A blank/NaN field must NOT silently
      // become an unlimited-spend pairing — require an explicit number (0 for
      // unlimited, which we log loudly).
      const rawLimit = nwcSpendingLimitInput.value.trim();
      if (rawLimit === "" || !/^\d+$/.test(rawLimit)) {
        appendLog(`[ERROR] Enter a spending limit in sats (use 0 for an explicitly unlimited pairing).`, "error");
        return;
      }
      const limit = parseInt(rawLimit, 10);
      if (limit === 0) {
        appendLog(`[NWC] ⚠ Creating an UNLIMITED-spend pairing "${name}" (no budget cap).`, "system");
      }

      const budgetRenewal = parseBudgetRenewal(nwcBudgetRenewalSelect.value);

      // Optional per-payment cap. A malformed entry is a hard error — a blank
      // means "no cap", but garbage must never silently become unlimited.
      const maxAmountRes = parseMaxAmount(nwcMaxAmountInput.value);
      if (!maxAmountRes.ok) {
        appendLog(`[ERROR] ${maxAmountRes.error}`, "error");
        return;
      }
      const maxAmountSats = maxAmountRes.value;

      const allowedMethods = buildAllowedMethods({
        pay_invoice: (document.getElementById("nwc-method-pay_invoice") as HTMLInputElement).checked,
        pay_keysend: (document.getElementById("nwc-method-pay_keysend") as HTMLInputElement).checked,
        make_invoice: (document.getElementById("nwc-method-make_invoice") as HTMLInputElement).checked,
        get_balance: (document.getElementById("nwc-method-get_balance") as HTMLInputElement).checked,
      });

      const expiresAt = expiryFromDays(parseInt(nwcExpirySelect.value, 10) || 0, Date.now());

      const summary = [
        `budget ${limit === 0 ? "unlimited" : limit + " sats"} (${renewalLabel(budgetRenewal)})`,
        maxAmountSats ? `max/payment ${maxAmountSats} sats` : null,
        allowedMethods ? `methods [${allowedMethods.join(", ") || "none"}]` : "all methods",
        expiresAt ? `expires ${new Date(expiresAt).toLocaleDateString()}` : "no expiry",
      ].filter(Boolean).join(", ");
      appendLog(`[NWC] Creating connection pairing "${name}" — ${summary} on relay ${relayUrl}...`, "system");
      const uri = await wallet.nwc.createConnection(name, {
        spendingLimitSats: limit,
        relayUrl,
        budgetRenewal,
        maxAmountSats,
        allowedMethods,
        expiresAt,
      });

      appendLog(`[NWC] Connection created successfully!`, "system");
      nwcUriStr.value = uri;
      // Render the QR locally. The pairing URI embeds the NWC spend-authority
      // secret — sending it to a third-party QR image service (as this once did)
      // hands that service full spend authority up to the cap. Keep it on-device.
      QRCode.toDataURL(uri, { width: 150, margin: 1 })
        .then((dataUrl) => {
          nwcQrImg.src = dataUrl;
          nwcQrImg.classList.remove("hidden");
        })
        .catch((e) => appendLog(`[NWC] Could not render QR locally: ${e?.message ?? e}`, "error"));
      nwcUriContainer.classList.remove("hidden");

      await updateNwcConnectionsList();
    } catch (err: any) {
      appendLog(`[ERROR] NWC connection creation failed: ${err.message}`, "error");
    } finally {
      createNwcBtn.disabled = false;
    }
  });

  copyNwcUriBtn.addEventListener("click", () => {
    if (!nwcUriStr.value) return;
    void copyToClipboard(nwcUriStr.value, "NWC Connection URI copied to clipboard.");
  });
}

/** Enable/disable the Create button; clears the URI + list when disabled (node stopped). */
export function setNwcEnabled(enabled: boolean) {
  createNwcBtn.disabled = !enabled;
  if (!enabled) {
    nwcUriContainer.classList.add("hidden");
    nwcConnectionsList.innerHTML = EMPTY_LIST;
  }
}

export async function updateNwcConnectionsList() {
  const wallet = ctx?.getWallet();
  if (!wallet) return;
  try {
    const list = await wallet.nwc.listConnections();
    nwcConnectionsList.innerHTML = "";

    if (list.length === 0) {
      nwcConnectionsList.innerHTML = EMPTY_LIST;
      return;
    }

    for (const conn of list) {
      const item = document.createElement("div");
      item.className = "connection-item";

      const details = document.createElement("div");
      details.className = "connection-details";

      const nameEl = document.createElement("div");
      nameEl.className = "connection-name";
      nameEl.innerText = conn.name;

      const metaEl = document.createElement("div");
      metaEl.className = "connection-meta";

      const pubkeyEl = document.createElement("span");
      pubkeyEl.className = "connection-pubkey";
      pubkeyEl.innerText = `${conn.clientPubkey.substring(0, 8)}...`;
      pubkeyEl.title = conn.clientPubkey;

      const limitEl = document.createElement("span");
      limitEl.className = "connection-limit";
      limitEl.innerText = conn.spendingLimitSats > 0
        ? `Budget: ${conn.spentTodaySats}/${conn.spendingLimitSats} sats (${renewalLabel(conn.budgetRenewal)})`
        : "Budget: Unlimited";

      const relayEl = document.createElement("span");
      relayEl.className = "connection-relay";
      relayEl.innerText = `Relay: ${conn.relayUrl}`;

      metaEl.appendChild(pubkeyEl);
      metaEl.appendChild(limitEl);

      if (conn.maxAmountSats && conn.maxAmountSats > 0) {
        const maxEl = document.createElement("span");
        maxEl.className = "connection-max";
        maxEl.innerText = `Max/payment: ${conn.maxAmountSats} sats`;
        metaEl.appendChild(maxEl);
      }

      if (conn.allowedMethods) {
        const methodsEl = document.createElement("span");
        methodsEl.className = "connection-methods";
        methodsEl.innerText = `Methods: ${conn.allowedMethods.join(", ") || "read-only"}`;
        metaEl.appendChild(methodsEl);
      }

      if (conn.expiresAt) {
        const expiryEl = document.createElement("span");
        expiryEl.className = "connection-expiry";
        const expired = Date.now() >= conn.expiresAt;
        expiryEl.innerText = expired
          ? `Expired ${new Date(conn.expiresAt).toLocaleDateString()}`
          : `Expires: ${new Date(conn.expiresAt).toLocaleDateString()}`;
        metaEl.appendChild(expiryEl);
      }

      metaEl.appendChild(relayEl);

      details.appendChild(nameEl);
      details.appendChild(metaEl);

      const revokeBtn = document.createElement("button");
      revokeBtn.className = "btn-revoke";
      revokeBtn.innerText = "Revoke";
      revokeBtn.addEventListener("click", async () => {
        try {
          revokeBtn.disabled = true;
          appendLog(`[NWC] Revoking connection for ${conn.name}...`, "system");
          await wallet.nwc.deleteConnection(conn.clientPubkey);
          appendLog(`[NWC] Connection revoked.`, "system");
          await updateNwcConnectionsList();
        } catch (e: any) {
          appendLog(`[ERROR] Failed to revoke connection: ${e.message}`, "error");
          revokeBtn.disabled = false;
        }
      });

      item.appendChild(details);
      item.appendChild(revokeBtn);
      nwcConnectionsList.appendChild(item);
    }
  } catch (err: any) {
    console.error("Failed to update connections list", err);
  }
}
