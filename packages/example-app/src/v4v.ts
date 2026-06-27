// V4V: audio-playback streaming micropayments + the boostagram sender (90/10 split
// or a 100% destination override). Owns the streaming interval state.
import { appendLog } from "./core/logger";
import { calculateSplits } from "@libre/shared";
import type { AppContext } from "./core/app-context";

const CREATOR_PUBKEY = "02bdafbf7a60765a9ab4673350c1b5954449e290f498d1ff3a77c58eb7cebfbf24";
const APP_DEV_PUBKEY = "035c6ec9ffea21051515efbb72d2fb07dfb51fa16d78772cc1c9b6348981f185ef";

const audioPlayer = document.getElementById("audio-player") as HTMLAudioElement;
const streamRateInput = document.getElementById("stream-rate-input") as HTMLInputElement;
const streamModeStatus = document.getElementById("stream-mode-status") as HTMLSpanElement;
const satsStreamedVal = document.getElementById("sats-streamed-val") as HTMLSpanElement;
const boostAmountInput = document.getElementById("boost-amount") as HTMLInputElement;
const boostMessageInput = document.getElementById("boost-message") as HTMLInputElement;
const boostSenderName = document.getElementById("boost-sender-name") as HTMLInputElement;
const boostDestInput = document.getElementById("boost-dest") as HTMLInputElement;
const sendBoostagramBtn = document.getElementById("send-boostagram-btn") as HTMLButtonElement;
const createInvoiceBtn = document.getElementById("create-invoice-btn") as HTMLButtonElement;

let streamIntervalId: any = null;
let totalSatsStreamed = 0;
let ctx: AppContext;

function stopStreaming() {
  if (streamIntervalId) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
  streamModeStatus.innerText = "Inactive";
  streamModeStatus.className = "value text-warning";
  appendLog("[V4V] Audio playback paused/stopped. Stopped streaming micropayments.", "system");
}

export function initV4V(c: AppContext) {
  ctx = c;

  audioPlayer.addEventListener("play", () => {
    const wallet = ctx.getWallet();
    if (!wallet || !ctx.isRunning()) {
      appendLog("[SYSTEM] Start the LDK Node before playing to enable V4V streaming.", "warn");
      audioPlayer.pause();
      return;
    }

    appendLog("[V4V] Audio playback started. Beginning streaming micropayments...", "system");
    streamModeStatus.innerText = "Active";
    streamModeStatus.className = "value text-success";

    if (streamIntervalId) clearInterval(streamIntervalId);

    // Send payments every 10 seconds (for testing convenience)
    streamIntervalId = setInterval(async () => {
      const w = ctx.getWallet();
      if (!w || !ctx.isRunning()) {
        clearInterval(streamIntervalId);
        return;
      }

      const rateSatsMin = parseInt(streamRateInput.value, 10);
      const amountSats = Math.max(1, Math.round((rateSatsMin * 10) / 60));

      appendLog(`[V4V] Streaming ${amountSats} sats (interval: 10s)...`, "info");

      const splits = calculateSplits({
        destinations: [
          { destinationPubkey: CREATOR_PUBKEY, share: 90 },
          { destinationPubkey: APP_DEV_PUBKEY, share: 10 },
        ],
        amountSats,
        boostRecordTemplate: {
          action: "stream",
          app_name: "v4vmusic-player",
          ts: Math.floor(audioPlayer.currentTime),
        },
      });

      const res = await w.sendSplitPayments(splits);
      if (res.ok) {
        totalSatsStreamed += amountSats;
        satsStreamedVal.innerText = totalSatsStreamed.toString();
        appendLog(`[V4V] Successfully streamed ${amountSats} sats split!`, "info");
      } else {
        appendLog(`[V4V] Failed streaming split payment: some recipients failed. Check LDK logs.`, "error");
      }
    }, 10000);
  });

  audioPlayer.addEventListener("pause", stopStreaming);
  audioPlayer.addEventListener("ended", stopStreaming);
  audioPlayer.addEventListener("error", stopStreaming);

  sendBoostagramBtn.addEventListener("click", async () => {
    const wallet = ctx.getWallet();
    if (!wallet || !ctx.isRunning()) return;
    try {
      sendBoostagramBtn.disabled = true;
      const amountSats = parseInt(boostAmountInput.value, 10);
      const message = boostMessageInput.value.trim();
      const senderName = boostSenderName.value.trim();

      appendLog(`[V4V] Preparing Boostagram of ${amountSats} sats with message: "${message}"...`, "system");

      // If a destination override pubkey is provided, route 100% there (e.g. your
      // channel peer, the only node you have a route to). Otherwise the demo 90/10 split.
      const destOverride = boostDestInput.value.trim();
      const destinations = /^0[0-9a-fA-F]{65}$/.test(destOverride)
        ? [{ destinationPubkey: destOverride, share: 100 }]
        : [
            { destinationPubkey: CREATOR_PUBKEY, share: 90 },
            { destinationPubkey: APP_DEV_PUBKEY, share: 10 },
          ];
      if (destinations.length === 1) {
        appendLog(`[V4V] Routing 100% to override destination ${destOverride.substring(0, 12)}...`, "system");
      }

      const splits = calculateSplits({
        destinations,
        amountSats,
        boostRecordTemplate: {
          action: "boost",
          app_name: "v4vmusic-player",
          message,
          sender_name: senderName,
          ts: Math.floor(audioPlayer.currentTime),
        },
      });

      const res = await wallet.sendSplitPayments(splits);
      if (res.ok) {
        appendLog(`[V4V] Boostagram sent successfully! Total ${amountSats} sats split:`, "info");
        for (const r of res.results) {
          const hash = r.result.ok ? r.result.paymentHash : "N/A";
          appendLog(` -> ${r.destinationPubkey.substring(0, 8)}... gets ${r.amountSats} sats, status: OK, paymentHash: ${hash}`, "info");
        }
      } else {
        appendLog(`[V4V] Failed to send Boostagram: one or more payments failed.`, "error");
        for (const r of res.results) {
          const status = r.result.ok ? "OK" : `Error: ${r.result.error}`;
          appendLog(` -> ${r.destinationPubkey.substring(0, 8)}... gets ${r.amountSats} sats, status: ${status}`, "error");
        }
      }
    } catch (err: any) {
      appendLog(`[ERROR] Boostagram sending failed: ${err.message}`, "error");
    } finally {
      sendBoostagramBtn.disabled = false;
      createInvoiceBtn.disabled = false;
    }
  });
}

/** Enable/disable boosting; on disable, stop streaming + reset counters (node stopped). */
export function setV4VEnabled(enabled: boolean) {
  sendBoostagramBtn.disabled = !enabled;
  if (!enabled) {
    audioPlayer.pause(); // triggers stopStreaming (clears interval, marks Inactive)
    totalSatsStreamed = 0;
    satsStreamedVal.innerText = "0";
  }
}
