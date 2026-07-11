import type { AppContext } from "../core/app-context";
import { formatOpeningFee } from "../core/lsps1-provider-ui";
import { LSPS1_PROVIDERS, quickChannelProvider } from "../core/lsps1-mock-provider";
import { driveConfigured } from "../drive-integration";
import { isDemoMode, demoState } from "../core/demo-mode";
import { lsps1OrderStatus, type Lsps1RestOrderResponse } from "@libre/shared";
import { registerScreen, showScreen } from "../ui/nav";
import { renderQr } from "../ui/qr";
import { $, show, setMsg, fmtSats, copyText } from "./util";

// The one-tap channel: a FIXED order — 150k sats, ~3-month lease, from Megalith (the 150k-
// minimum, instant-0-conf mainnet LSP). Placing the order only fetches a quote + invoice;
// nothing is spent until the user pays it.
const QUICK_CHANNEL_SATS = 150000;
const QUICK_CHANNEL_LEASE_BLOCKS = 12960; // ~3 months (Megalith's max lease); clamped LSP-side

export function initGetChannelScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  let pollToken = 0;
  let busy = false;

  function stopPolling(): void {
    pollToken++;
  }

  function pollOrder(apiUrl: string, orderId: string): void {
    const token = ++pollToken;
    const deadline = Date.now() + 15 * 60 * 1000;
    const tick = async () => {
      if (token !== pollToken) return;
      try {
        const order = (await controller.getLSPS1Order(apiUrl, orderId)) as Lsps1RestOrderResponse;
        if (token !== pollToken) return;
        const status = lsps1OrderStatus(order);
        if (status === "completed") {
          stopPolling();
          showScreen("screen-chan-success");
          return;
        }
        if (status === "failed") {
          setMsg("quick-channel-msg", "Order failed — the LSP could not open the channel. No sats were kept.", "err");
          return;
        }
        if (status === "paid") {
          setMsg("quick-channel-msg", "✓ Payment received — opening your channel…", "ok");
          show("quick-channel-qr", false);
        }
      } catch {
        /* transient — keep polling */
      }
      if (token === pollToken && Date.now() < deadline) setTimeout(() => void tick(), 4000);
    };
    setTimeout(() => void tick(), 4000);
  }

  async function placeOrder(): Promise<void> {
    if (busy) return;
    // MANDATORY cloud backup: never let funds land in a channel before there's an off-device
    // backup destination. Onboarding gates this too — this in-function re-check is the
    // belt-and-suspenders half of the double-gate.
    if (!(isDemoMode() ? demoState.driveConfigured : driveConfigured())) {
      setMsg(
        "quick-channel-msg",
        "Turn on cloud backup (Google Drive) first — a channel can't be recovered without a backup.",
        "err",
      );
      return;
    }
    const s = await controller.getState().catch(() => null);
    if (!s?.running) {
      setMsg("quick-channel-msg", "The node isn't running — start it from the menu first.", "err");
      return;
    }
    const provider = quickChannelProvider(LSPS1_PROVIDERS);
    busy = true;
    $("qc-provider").textContent = provider.name;
    $("qc-size").textContent = `${fmtSats(QUICK_CHANNEL_SATS)} sats`;
    $("qc-fee").textContent = "…";
    show("quick-channel-qr", false);
    show("quick-channel-invoice", false);
    show("quick-channel-copy", false);
    setMsg("quick-channel-msg", `Getting a quote from ${provider.name}…`);
    try {
      const order = await controller.purchaseLSPS1Capacity({
        amountSats: QUICK_CHANNEL_SATS,
        apiUrl: provider.restBaseUrl,
        providerName: provider.name,
        channelExpiryBlocks: QUICK_CHANNEL_LEASE_BLOCKS,
      });
      $("qc-fee").textContent = formatOpeningFee(order.feeTotalSat, QUICK_CHANNEL_SATS);
      const inv = $<HTMLTextAreaElement>("quick-channel-invoice");
      inv.value = order.invoice;
      show(inv, true);
      show("quick-channel-copy", true);
      await renderQr($<HTMLImageElement>("quick-channel-qr"), order.invoice);
      setMsg("quick-channel-msg", "Waiting for payment…");
      pollOrder(provider.restBaseUrl, order.orderId);
    } catch (e) {
      setMsg("quick-channel-msg", (e as Error).message, "err");
    } finally {
      busy = false;
    }
  }

  $("quick-channel-copy").addEventListener("click", () => {
    void copyText($<HTMLTextAreaElement>("quick-channel-invoice").value).then((ok) =>
      setMsg("quick-channel-msg", ok ? "Invoice copied" : "Couldn't copy — select the invoice text manually.", ok ? "ok" : "err"),
    );
  });

  registerScreen("screen-get-channel", {
    onShow: () => {
      void (async () => {
        // Honest framing for a returning user: after a close this is a REPLACEMENT channel.
        try {
          const s = await controller.getState();
          $("gc-title").textContent = (s.closes?.count ?? 0) > 0 ? "Get a new channel" : "Get a channel";
        } catch { /* keep the static title */ }
        await placeOrder();
      })();
    },
    onHide: () => stopPolling(),
  });
}
