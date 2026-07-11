// Tiny DOM helpers shared by the screen modules.

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export const show = (elOrId: HTMLElement | string, on: boolean): void => {
  const el = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
  el?.classList.toggle("hidden", !on);
};

export const setMsg = (id: string, text: string, kind: "" | "ok" | "err" = ""): void => {
  const m = document.getElementById(id);
  if (!m) return;
  m.textContent = text;
  m.className = `msg ${kind}`;
};

export const fmtSats = (n: number): string => Math.round(n).toLocaleString("en-US");

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
