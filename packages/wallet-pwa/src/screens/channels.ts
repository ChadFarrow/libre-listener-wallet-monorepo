import type { AppContext } from "../core/app-context";
import type { ChannelInfo } from "@libre/listener-wallet";
import { channelConfLabel } from "@libre/shared";
import { onControllerEvent } from "../core/events";
import { registerScreen, currentScreen, showScreen } from "../ui/nav";
import { relativeTime } from "../core/tx-format";
import { $, fmtSats } from "./util";

// Per-channel cards: capacity bar (spendable / estimated ~1% reserve / receivable) + numbers.
// ChannelInfo exposes no exact reserve — LDK nets it out of outboundSendableSat — so the bar's
// reserve segment is the ceil(capacity/100) estimate (same rule as core/reserve-hint.ts).

export function initChannelsScreen(ctx: AppContext): void {
  const controller = ctx.controller;

  function channelCard(c: ChannelInfo): HTMLElement {
    const card = document.createElement("div");
    card.className = "chan-card";

    const reserveSat = Math.min(Math.ceil(c.capacitySat / 100), Math.max(0, c.capacitySat - c.outboundSendableSat - c.inboundSat));
    const pct = (n: number) => `${Math.max(0.5, (n / Math.max(1, c.capacitySat)) * 100)}%`;
    const conf = channelConfLabel(c.confirmations, c.confirmationsRequired, c.isChannelReady);
    const state = c.isUsable ? "active" : c.isChannelReady ? "peer offline" : `pending${conf ? ` · ${conf}` : ""}`;

    const head = document.createElement("div");
    head.className = "chan-head";
    const pk = document.createElement("span");
    pk.className = "peer-pk";
    pk.textContent = `${c.counterpartyNodeId.slice(0, 10)}…${c.counterpartyNodeId.slice(-6)}`;
    const tag = document.createElement("span");
    tag.className = "p-tag";
    if (!c.isUsable) tag.style.cssText = "color:var(--warn);background:rgba(240,180,41,0.12)";
    tag.textContent = state;
    head.append(pk, tag);

    const bar = document.createElement("div");
    bar.className = "cap-bar";
    for (const [cls, sats] of [
      ["sp", c.outboundSendableSat],
      ["rs", reserveSat],
      ["rv", c.inboundSat],
    ] as const) {
      const seg = document.createElement("i");
      seg.className = cls;
      seg.style.width = pct(sats);
      bar.appendChild(seg);
    }

    const legend = document.createElement("div");
    legend.className = "bar-legend";
    legend.innerHTML =
      `<span><i class="dotc" style="background:var(--accent)"></i>Spendable</span>` +
      `<span><i class="dotc" style="background:#666"></i>Reserve (est.)</span>` +
      `<span><i class="dotc" style="background:rgba(34,196,94,0.22)"></i>Receivable</span>`;

    const rows = document.createElement("div");
    for (const [label, value] of [
      ["Spendable", `${fmtSats(c.outboundSendableSat)} sats`],
      ["Reserve (locked, est.)", `${fmtSats(reserveSat)} sats`],
      ["Receivable", `${fmtSats(c.inboundSat)} sats`],
      ["Capacity", `${fmtSats(c.capacitySat)} sats`],
    ]) {
      const row = document.createElement("div");
      row.className = "order-row";
      const k = document.createElement("span");
      k.textContent = label;
      const v = document.createElement("b");
      v.textContent = value;
      row.append(k, v);
      rows.appendChild(row);
    }

    card.append(head, bar, legend, rows);
    return card;
  }

  async function refresh(): Promise<void> {
    const host = $("channels-list");
    host.innerHTML = "";
    const note = document.createElement("p");
    note.className = "center-note";
    if (!ctx.isRunning()) {
      note.textContent = "Start the node to see your channels.";
      host.appendChild(note);
      return;
    }
    const chans = await controller.getChannels().catch(() => [] as ChannelInfo[]);
    if (!chans.length) {
      const s = await controller.getState().catch(() => null);
      const closes = s?.closes?.count ?? 0;
      const sweep = s?.sweep;
      if (closes > 0 || sweep?.needsAddress || (sweep?.pendingCount ?? 0) > 0) {
        const when = s?.closes?.last ? ` ${relativeTime(s.closes.last.closedAt, Date.now())}` : "";
        note.textContent = `Your channel closed${when}.`;
        host.appendChild(note);
        const sweepNote = document.createElement("p");
        sweepNote.className = "center-note";
        if (sweep?.needsAddress) {
          sweepNote.textContent = "Funds are waiting — set a recovery address to get them back on-chain.";
        } else if ((sweep?.pendingCount ?? 0) > 0) {
          sweepNote.textContent =
            (sweep?.pendingSat ?? 0) > 0
              ? `Recovering ${fmtSats(sweep!.pendingSat)} sats to your on-chain address…`
              : "Recovering your funds on-chain…";
        } else if (sweep?.lastSweep) {
          sweepNote.textContent = `${fmtSats(sweep.lastSweep.sat)} sats were sent to your recovery address.`;
        } else {
          sweepNote.textContent = "Get a new channel to keep sending and receiving.";
        }
        host.appendChild(sweepNote);
        return;
      }
      note.textContent = "No channels yet — get one to receive.";
      host.appendChild(note);
      return;
    }
    for (const c of chans) host.appendChild(channelCard(c));
  }

  $("channels-get-another").addEventListener("click", () => showScreen("screen-get-channel"));

  registerScreen("screen-channels", { onShow: () => void refresh() });
  onControllerEvent(() => {
    if (currentScreen() === "screen-channels") void refresh();
  });
}
