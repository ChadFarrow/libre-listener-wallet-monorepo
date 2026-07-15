import { MSG } from "../core/messages";
import { parseCapInput } from "@libre/wallet-core";

// Approval prompt shown in its own popup window when an un-granted origin calls webln.enable().
// Sends the user's decision back to the background, which is holding the enable() promise. If the
// window is closed without a choice, the background treats it as a denial (windows.onRemoved).

const qs = new URLSearchParams(location.search);
const origin = qs.get("origin") || "unknown site";
const id = qs.get("id") || "";

document.getElementById("origin")!.textContent = origin;

function send(approved: boolean, spendingLimitSats: number): void {
  // Include the origin so the background can persist the grant on the decision itself (durable
  // across an MV3 service-worker restart while this window was open).
  void chrome.runtime
    .sendMessage({ kind: MSG.APPROVAL_DECISION, id, origin, approved, spendingLimitSats })
    .finally(() => window.close());
}

function approve(): void {
  const unlimited = (document.getElementById("unlimited") as HTMLInputElement).checked;
  const err = document.getElementById("cap-error")!;
  if (unlimited) {
    // Only ever grant an unlimited cap through this explicit, deliberate opt-in — never via a
    // blank or unparseable number field.
    send(true, 0);
    return;
  }
  const parsed = parseCapInput((document.getElementById("cap") as HTMLInputElement).value);
  if (!parsed.ok) {
    err.textContent = "Enter a whole number of sats greater than 0, or check “No daily limit”.";
    return;
  }
  err.textContent = "";
  send(true, parsed.sats);
}

document.getElementById("approve")!.addEventListener("click", approve);
document.getElementById("deny")!.addEventListener("click", () => send(false, 0));
