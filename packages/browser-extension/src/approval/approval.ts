import { MSG } from "../core/messages";

// Approval prompt shown in its own popup window when an un-granted origin calls webln.enable().
// Sends the user's decision back to the background, which is holding the enable() promise. If the
// window is closed without a choice, the background treats it as a denial (windows.onRemoved).

const qs = new URLSearchParams(location.search);
const origin = qs.get("origin") || "unknown site";
const id = qs.get("id") || "";

document.getElementById("origin")!.textContent = origin;

function decide(approved: boolean): void {
  const cap = Number((document.getElementById("cap") as HTMLInputElement).value);
  void chrome.runtime
    .sendMessage({
      kind: MSG.APPROVAL_DECISION,
      id,
      approved,
      spendingLimitSats: Number.isFinite(cap) && cap >= 0 ? cap : 0,
    })
    .finally(() => window.close());
}

document.getElementById("approve")!.addEventListener("click", () => decide(true));
document.getElementById("deny")!.addEventListener("click", () => decide(false));
