import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { parseNwcLimit } from "../core/nwc-limit";
import { presetToAllowedMethods, presetLabel, type NwcPermissionPreset } from "../core/nwc-presets";
import { limitLabel, expiryLabel, type NwcConnectionView } from "../core/nwc-connection-view";
import { expiryFromDays, parseBudgetRenewal } from "@libre/shared";
import { guardedClick } from "../core/ui-helpers";
import { confirmModal } from "../ui/confirm-modal";
import { registerScreen, currentScreen, showScreen, goBack } from "../ui/nav";
import { renderQr } from "../ui/qr";
import { $, show, setMsg, fmtSats, copyText } from "./util";

// NWC pairings: list → per-connection detail (spent this period, revoke) → create flow with
// permission presets / limit + renewal / expiry, ending in an on-device pairing QR. The URI
// embeds the spend secret — it renders once and is never shown again.

export function initAppConnectionsScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  let detail: NwcConnectionView | null = null;

  function allowedLabel(c: NwcConnectionView): string {
    if (!c.allowedMethods) return presetLabel("full");
    const spend = c.allowedMethods.some((m) => m === "pay_invoice" || m === "pay_keysend");
    return spend ? presetLabel("pay") : presetLabel("readonly");
  }

  async function refreshList(): Promise<void> {
    const host = $("appconn-list");
    host.innerHTML = "";
    let list: NwcConnectionView[] = [];
    try {
      list = await controller.nwcListConnections();
      setMsg("appconn-list-msg", "");
    } catch (e) {
      setMsg("appconn-list-msg", (e as Error).message, "err");
      return;
    }
    if (!list.length) {
      const note = document.createElement("p");
      note.className = "center-note";
      note.textContent = "No app connections yet.";
      host.appendChild(note);
      return;
    }
    for (const c of list) {
      const row = document.createElement("button");
      row.className = "peer-row";
      const dot = document.createElement("span");
      dot.className = "p-dot";
      const main = document.createElement("div");
      main.className = "p-main";
      const name = document.createElement("div");
      name.className = "p-name";
      name.textContent = c.name;
      const sub = document.createElement("div");
      sub.className = "p-sub2";
      sub.textContent = `${allowedLabel(c)} · ${limitLabel(c.spendingLimitSats, c.budgetRenewal)}`;
      main.append(name, sub);
      row.append(dot, main);
      row.addEventListener("click", () => {
        detail = c;
        openDetail(c);
      });
      host.appendChild(row);
    }
  }

  function openDetail(c: NwcConnectionView): void {
    $("acd-title").textContent = c.name;
    $("acd-perms").textContent = allowedLabel(c);
    $("acd-limit").textContent = limitLabel(c.spendingLimitSats, c.budgetRenewal);
    $("acd-spent").textContent = `${fmtSats(c.spentThisPeriodSats)} sats`;
    $("acd-created").textContent = c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "—";
    $("acd-expiry").textContent = expiryLabel(c.expiresAt, Date.now());
    setMsg("acd-msg", "");
    showScreen("screen-appconn-detail");
  }

  $("acd-revoke").addEventListener("click", () => {
    void (async () => {
      if (!detail) return;
      const ok = await confirmModal({
        title: `Revoke ${detail.name}?`,
        body: "The app immediately loses access to this wallet. You can always pair it again with a new connection.",
        confirmLabel: "Revoke",
        danger: true,
      });
      if (!ok) return;
      try {
        await controller.nwcDeleteConnection(detail.clientPubkey);
        detail = null;
        goBack();
      } catch (e) {
        setMsg("acd-msg", (e as Error).message, "err");
      }
    })();
  });

  // ---- create flow ----
  const chipVal = (groupId: string): string =>
    document.querySelector<HTMLElement>(`#${groupId} .chip.on`)?.dataset.v ?? "";

  for (const group of Array.from(document.querySelectorAll<HTMLElement>(".chip-group"))) {
    group.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>(".chip");
      if (!chip) return;
      for (const c of Array.from(group.querySelectorAll(".chip"))) c.classList.remove("on");
      chip.classList.add("on");
      if (group.id === "appconn-perms") {
        show("appconn-limit-block", chipVal("appconn-perms") !== "readonly");
      }
    });
  }

  function openCreate(): void {
    $<HTMLInputElement>("appconn-name").value = "";
    show("appconn-form", true);
    show("appconn-result", false);
    setMsg("appconn-msg", "");
    showScreen("screen-appconn-new");
  }
  $("btn-appconn-new").addEventListener("click", openCreate);
  $("btn-appconn-add").addEventListener("click", openCreate);

  // guardedClick: a double-tap must not mint two live pairings (two spend secrets).
  guardedClick($<HTMLButtonElement>("appconn-create"), async () => {
    const preset = (chipVal("appconn-perms") || "full") as NwcPermissionPreset;
    const readonly = preset === "readonly";
    const limitRes = readonly ? { ok: true as const, value: 0 } : parseNwcLimit($<HTMLInputElement>("appconn-limit").value.replace(/,/g, ""));
    if (!limitRes.ok) {
      setMsg("appconn-msg", limitRes.error, "err");
      return;
    }
    setMsg("appconn-msg", "Creating pairing…");
    try {
      const { uri } = await controller.nwcCreateConnection($<HTMLInputElement>("appconn-name").value.trim() || "Nostr app", {
        spendingLimitSats: limitRes.value,
        budgetRenewal: parseBudgetRenewal(chipVal("appconn-renew") || "daily"),
        allowedMethods: presetToAllowedMethods(preset),
        expiresAt: expiryFromDays(parseInt(chipVal("appconn-expiry") || "0", 10), Date.now()),
      });
      $<HTMLTextAreaElement>("appconn-uri").value = uri;
      show("appconn-form", false);
      show("appconn-result", true);
      await renderQr($<HTMLImageElement>("appconn-qr"), uri);
      setMsg("appconn-msg", "");
    } catch (e) {
      setMsg("appconn-msg", (e as Error).message, "err");
    }
  });

  $("appconn-copy").addEventListener("click", () => {
    void copyText($<HTMLTextAreaElement>("appconn-uri").value).then((ok) =>
      setMsg("appconn-msg", ok ? "Pairing string copied" : "Couldn't copy — select the text manually.", ok ? "ok" : "err"),
    );
  });
  $("appconn-done").addEventListener("click", () => {
    // Wipe the secret-bearing URI before leaving — it can't be shown again by design.
    $<HTMLTextAreaElement>("appconn-uri").value = "";
    $<HTMLImageElement>("appconn-qr").src = "";
    goBack();
  });

  registerScreen("screen-appconns", { onShow: () => void refreshList() });
  registerScreen("screen-appconn-new", {
    onHide: () => {
      $<HTMLTextAreaElement>("appconn-uri").value = "";
      $<HTMLImageElement>("appconn-qr").src = "";
    },
  });
  registerScreen("screen-appconn-detail", {});
  onControllerEvent(() => {
    if (currentScreen() === "screen-appconns") void refreshList();
  });
}
