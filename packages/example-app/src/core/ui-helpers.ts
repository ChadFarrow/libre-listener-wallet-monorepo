// Small DOM/UI utilities shared across feature modules.
import { appendLog } from "./logger";

/** Copy text to the clipboard and log the given confirmation message. */
export async function copyToClipboard(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    appendLog(`[SYSTEM] ${message}`, "system");
  } catch (e) {
    appendLog(`[ERROR] Copy failed: ${e instanceof Error ? e.message : e}`, "error");
  }
}

export function show(el: HTMLElement): void {
  el.classList.remove("hidden");
}

export function hide(el: HTMLElement): void {
  el.classList.add("hidden");
}
