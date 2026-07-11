import type { AppContext } from "../core/app-context";
import type { PaymentRecord } from "@libre/shared";
import { onControllerEvent } from "../core/events";
import { formatAmount, relativeTime, groupByDay, channelEventLabel, type ChannelEventRecord } from "../core/tx-format";
import { getUsdRate, satsToUsd } from "../core/fiat-rate";
import { onSheetOpen, isSheetOpen } from "../ui/nav";
import { $ } from "./util";

// The swipe-up transactions sheet. Rows are built with createElement/textContent — record
// strings (boost notes, counterparties) never touch innerHTML, so no escaping is needed.

const ARROW_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m0 0l-5 5m5-5l5 5"/></svg>';
const ARROW_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14m0 0l-5-5m5 5l5-5"/></svg>';
const CLOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4l2.5 2.5"/></svg>';
const CROSS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const LINK_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 12h6M7.5 8.5L5 11a4 4 0 105.7 5.7l1.3-1.4M16.5 15.5L19 13a4 4 0 10-5.7-5.7l-1.3 1.4"/></svg>';

function contextLine(rec: PaymentRecord): string {
  if (rec.note) return rec.note;
  if (rec.counterparty) return `${rec.counterparty.slice(0, 12)}…${rec.counterparty.slice(-6)}`;
  return rec.type === "keysend" ? "keysend" : "invoice";
}

function txRow(rec: PaymentRecord, now: number, usdRate: number | null): HTMLElement {
  const row = document.createElement("div");
  const stateClass = rec.status === "settled" ? rec.direction : rec.status;
  row.className = `tx ${rec.direction} ${stateClass}`;

  const ico = document.createElement("div");
  ico.className = "tx-ico";
  ico.innerHTML =
    rec.status === "pending" ? CLOCK : rec.status === "failed" ? CROSS : rec.direction === "sent" ? ARROW_UP : ARROW_DOWN;

  const mid = document.createElement("div");
  mid.className = "tx-mid";
  const l1 = document.createElement("div");
  l1.className = "tx-l1";
  const label = document.createElement("span");
  label.textContent = rec.direction === "sent" ? "Sent" : "Received";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = relativeTime(rec.timestamp, now);
  l1.append(label, when);
  mid.appendChild(l1);
  const ctx = contextLine(rec);
  if (ctx) {
    const l2 = document.createElement("div");
    l2.className = "tx-l2";
    l2.textContent = ctx;
    mid.appendChild(l2);
  }

  const amt = document.createElement("div");
  amt.className = "tx-amt";
  const sats = document.createElement("div");
  sats.className = "sats";
  sats.textContent = formatAmount(rec).replace(" sat", " sats");
  amt.appendChild(sats);
  const sub = document.createElement("div");
  sub.className = "sub";
  if (rec.status === "pending") {
    sub.innerHTML = '<span class="tx-tag pending">Pending</span>';
  } else if (rec.status === "failed") {
    sub.innerHTML = '<span class="tx-tag failed">Failed</span>';
  } else if (rec.feeSats) {
    sub.textContent = `fee ${Math.round(rec.feeSats)} sat`;
  } else if (usdRate != null && rec.amountSats > 0) {
    sub.textContent = `$${satsToUsd(rec.amountSats, usdRate).toFixed(2)}`;
  }
  if (sub.textContent || sub.innerHTML) amt.appendChild(sub);

  row.append(ico, mid, amt);
  return row;
}

function channelEventRow(rec: ChannelEventRecord, now: number): HTMLElement {
  const row = document.createElement("div");
  row.className = `tx ${rec.kind === "sweep" ? "received" : "chan-event"}`;

  const ico = document.createElement("div");
  ico.className = "tx-ico";
  ico.innerHTML = rec.kind === "sweep" ? ARROW_DOWN : LINK_OFF;

  const mid = document.createElement("div");
  mid.className = "tx-mid";
  const l1 = document.createElement("div");
  l1.className = "tx-l1";
  const label = document.createElement("span");
  label.textContent = channelEventLabel(rec);
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = relativeTime(rec.timestamp, now);
  l1.append(label, when);
  mid.appendChild(l1);
  if (rec.kind === "channel-close" && rec.reason) {
    const l2 = document.createElement("div");
    l2.className = "tx-l2";
    l2.textContent = rec.reason.replace(/-/g, " ");
    mid.appendChild(l2);
  }

  const amt = document.createElement("div");
  amt.className = "tx-amt";
  if (rec.kind === "sweep" && rec.sat) {
    const sats = document.createElement("div");
    sats.className = "sats";
    sats.textContent = `+${Math.abs(Math.round(rec.sat)).toLocaleString("en-US")} sats`;
    amt.appendChild(sats);
  }

  row.append(ico, mid, amt);
  return row;
}

export function initTransactionsSheet(ctx: AppContext): void {
  const controller = ctx.controller;

  async function refresh(): Promise<void> {
    const host = $("txlist");
    let records: PaymentRecord[] = [];
    try {
      records = await controller.getPayments();
    } catch (e) {
      console.warn("[Tx] getPayments failed:", (e as Error)?.message || e);
    }
    let events: ChannelEventRecord[] = [];
    try {
      const closes = await controller.getChannelCloses();
      events = closes.map((c) => ({ kind: "channel-close" as const, timestamp: c.closedAt, reason: c.reason }));
      const s = await controller.getState();
      if (s.sweep?.lastSweep) {
        events.push({ kind: "sweep", timestamp: s.sweep.lastSweep.at, sat: s.sweep.lastSweep.sat });
      }
    } catch (e) {
      console.warn("[Tx] channel events unavailable:", (e as Error)?.message || e);
    }
    host.innerHTML = "";
    if (!records.length && !events.length) {
      const note = document.createElement("p");
      note.className = "center-note";
      note.id = "tx-empty";
      note.textContent = "No transactions yet.";
      host.appendChild(note);
      return;
    }
    const now = Date.now();
    const usdRate = await getUsdRate();
    type SheetItem = { timestamp: number; payment?: PaymentRecord; event?: ChannelEventRecord };
    const items: SheetItem[] = [
      ...records.map((p) => ({ timestamp: p.timestamp, payment: p })),
      ...events.map((ev) => ({ timestamp: ev.timestamp, event: ev })),
    ].sort((a, b) => b.timestamp - a.timestamp);
    for (const group of groupByDay(items, now)) {
      const sep = document.createElement("div");
      sep.className = "day-sep";
      sep.textContent = group.label;
      host.appendChild(sep);
      for (const item of group.records) {
        host.appendChild(item.payment ? txRow(item.payment, now, usdRate) : channelEventRow(item.event!, now));
      }
    }
  }

  onSheetOpen(() => void refresh());
  onControllerEvent(() => {
    if (isSheetOpen()) void refresh();
  });
  // Belt for pending→settled edge timing while the user is watching — only while open.
  setInterval(() => {
    if (isSheetOpen() && !document.hidden) void refresh();
  }, 10_000);
}
