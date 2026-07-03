// Nostr Wallet Connect UI: create a pairing (URI + QR), copy it, and the
// active-pairings list with revoke. Exposes setNwcEnabled/updateNwcConnectionsList
// for the node start/stop handlers.
import QRCode from "qrcode";
import { appendLog } from "./core/logger";
import { copyToClipboard } from "./core/ui-helpers";
import type { AppContext } from "./core/app-context";

const createNwcBtn = document.getElementById("create-nwc-btn") as HTMLButtonElement;
const nwcConnNameInput = document.getElementById("nwc-conn-name") as HTMLInputElement;
const nwcSpendingLimitInput = document.getElementById("nwc-spending-limit") as HTMLInputElement;
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
        appendLog(`[NWC] ⚠ Creating an UNLIMITED-spend pairing "${name}" (no daily cap).`, "system");
      }

      appendLog(`[NWC] Creating connection pairing: "${name}" with limit: ${limit === 0 ? "unlimited" : limit + " sats"} on relay ${relayUrl}...`, "system");
      const uri = await wallet.nwc.createConnection(name, { spendingLimitSats: limit, relayUrl });

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
        ? `Limit: ${conn.spentTodaySats}/${conn.spendingLimitSats} sats`
        : "Limit: Unlimited";

      const relayEl = document.createElement("span");
      relayEl.className = "connection-relay";
      relayEl.innerText = `Relay: ${conn.relayUrl}`;

      metaEl.appendChild(pubkeyEl);
      metaEl.appendChild(limitEl);
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
