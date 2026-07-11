import type { AppContext } from "../core/app-context";
import { onControllerEvent } from "../core/events";
import { currentOnboardingStep, type OnboardingStep } from "../core/onboarding-flow";
import { getSeedBackedUp, setSeedBackedUp } from "../core/onboarding";
import { driveConfigured, ensureDriveConnected, driveBackupNow } from "../drive-integration";
import { isDriveForeignBackupError } from "../drive-backup";
import { isDemoMode, demoState } from "../core/demo-mode";
import { currentScreen, showScreen } from "../ui/nav";
import { $, show, setMsg } from "./util";

// The onboarding HARD GATE: home is unreachable until create → seed saved → Drive → channel
// are all done. On every boot/state change the gate re-evaluates and resumes at the first
// incomplete step (an app kill mid-flow can't skip anything). The overlay only asserts itself
// while home is the current screen — sub-screens it launched (restore, get-channel) run
// underneath and return to it.

const BOLT_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M13 3L4 14h6l-1 7 9-11h-6l1-7z"/></svg>';
const ICONS: Record<string, string> = {
  lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 118 0v3"/>',
  cloud: '<path d="M6 19a4 4 0 01-.5-7.97A6 6 0 0117.4 9.6 4.5 4.5 0 0117.5 19H6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

const STEP_ORDER: OnboardingStep[] = ["welcome", "seed", "drive", "channel"];

export function initOnboarding(ctx: AppContext): void {
  const controller = ctx.controller;
  const host = $("onboarding");
  let renderedStep: OnboardingStep | "" = "";
  let busy = false;
  let done = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  async function evaluate(): Promise<void> {
    try {
      const s = await controller.getState();
      const step = currentOnboardingStep({
        hasWallet: s.hasSeed || s.createdNew || s.hasChannelState,
        backedUp: isDemoMode() ? demoState.seedBackedUp : getSeedBackedUp(s.network),
        driveConfigured: isDemoMode() ? demoState.driveConfigured : driveConfigured(),
        // While stopped we can't count channels; existing channel state means this wallet
        // completed onboarding before — the status pill owns any post-onboarding gaps.
        channels: s.running ? (s.channels ?? 0) : s.hasChannelState ? 1 : 0,
        everHadChannel: (s.closes?.count ?? 0) > 0 || s.hasChannelState,
      });
      if (step === "done") {
        done = true;
        if (pollTimer) clearInterval(pollTimer);
        hideOverlay();
        return;
      }
      // Don't fight a sub-screen the flow itself launched (restore / get-channel / success).
      if (currentScreen() !== "screen-home") {
        hideOverlay();
        renderedStep = "";
        return;
      }
      show(host, true);
      if (renderedStep !== step) render(step);
    } catch (e) {
      console.warn("[Onboarding] gate check failed:", (e as Error)?.message || e);
    }
  }

  function hideOverlay(): void {
    show(host, false);
    wipeSeed();
  }

  function wipeSeed(): void {
    const el = document.getElementById("ob-seed-hex");
    if (el) el.textContent = "•".repeat(64);
  }

  function renderProgress(step: OnboardingStep): void {
    const idx = STEP_ORDER.indexOf(step);
    $("ob-progress").innerHTML = STEP_ORDER.map((_, i) => `<i class="${i <= idx ? "done" : ""}"></i>`).join("");
  }

  function emblem(icon: string, logo = false): string {
    return logo
      ? `<div class="emblem logo-mark">${BOLT_SVG}</div>`
      : `<div class="emblem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>`;
  }

  function foot(...els: HTMLElement[]): void {
    const f = $("ob-foot");
    f.innerHTML = "";
    for (const el of els) f.appendChild(el);
    const msg = document.createElement("p");
    msg.className = "msg";
    msg.id = "ob-msg";
    f.appendChild(msg);
  }

  function button(label: string, cls: string, onClick: () => void | Promise<void>): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", () => {
      if (busy) return;
      const r = onClick();
      if (r instanceof Promise) {
        busy = true;
        b.disabled = true;
        void r.finally(() => {
          busy = false;
          b.disabled = false;
        });
      }
    });
    return b;
  }

  function render(step: OnboardingStep): void {
    renderedStep = step;
    renderProgress(step);
    const body = $("ob-body");

    if (step === "welcome") {
      body.innerHTML = `${emblem("", true)}
        <h1>Your wallet,<br/>no one else's.</h1>
        <p>Libre runs a real Lightning node right here on your phone. No account, no company holding your sats.</p>`;
      foot(
        button("Create wallet", "btn-primary", async () => {
          setMsg("ob-msg", "Creating your wallet…");
          try {
            await controller.createWallet();
            setMsg("ob-msg", "");
          } catch (e) {
            // The wallet exists even if the node didn't start (createWallet writes the seed
            // first) — continue to the seed step; the pill surfaces the start error later.
            setMsg("ob-msg", `Wallet created, but the node didn't start: ${(e as Error).message}`, "err");
          }
          await evaluate();
        }),
        button("Restore an existing wallet", "btn-ghost", () => {
          hideOverlay();
          renderedStep = "";
          showScreen("screen-restore");
        }),
      );
      return;
    }

    if (step === "seed") {
      body.innerHTML = `${emblem(ICONS.lock)}
        <h1>Save your<br/>wallet seed.</h1>
        <p>This key is the only way back into your wallet if you lose this device. Keep it secret — anyone with it can spend your sats. A password manager is a great place to save it.</p>
        <div>
          <button class="seed-hex masked" id="ob-seed-hex"></button>
          <div class="seed-hint" id="ob-seed-hint">Tap to reveal</div>
          <div class="seed-actions"><button class="btn-ghost" id="ob-seed-copy">Copy seed</button></div>
          <label class="ob-check"><input type="checkbox" id="ob-seed-ok" /> I saved my seed somewhere safe.</label>
        </div>`;
      wipeSeed();
      let revealed = false;
      let seedHex = "";
      const hexEl = $("ob-seed-hex");
      const loadSeed = async (): Promise<string> => {
        if (!seedHex) seedHex = (await controller.getSeed()).seedHex;
        return seedHex;
      };
      hexEl.addEventListener("click", () => {
        void (async () => {
          try {
            revealed = !revealed;
            hexEl.classList.toggle("masked", !revealed);
            hexEl.textContent = revealed ? await loadSeed() : "";
            if (!revealed) wipeSeed();
            $("ob-seed-hint").textContent = revealed ? "Tap to hide" : "Tap to reveal";
          } catch (e) {
            setMsg("ob-msg", (e as Error).message, "err");
          }
        })();
      });
      $("ob-seed-copy").addEventListener("click", () => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(await loadSeed());
            setMsg("ob-msg", "Seed copied — store it somewhere safe.", "ok");
          } catch {
            setMsg("ob-msg", "Couldn't copy — reveal the seed and copy it manually.", "err");
          }
        })();
      });
      const cont = button("Continue", "btn-primary", async () => {
        if (isDemoMode()) {
          demoState.seedBackedUp = true;
        } else {
          const st = await controller.getState().catch(() => null);
          if (st) setSeedBackedUp(st.network);
        }
        await evaluate();
      });
      cont.disabled = true;
      foot(cont);
      $("ob-seed-ok").addEventListener("change", (e) => {
        cont.disabled = !(e.target as HTMLInputElement).checked;
      });
      return;
    }

    if (step === "drive") {
      body.innerHTML = `${emblem(ICONS.cloud)}
        <h1>Back up to<br/>your cloud.</h1>
        <p>An encrypted copy of your wallet keeps your channel state safe. Only your wallet seed unlocks it — Google never sees your sats.</p>`;
      foot(
        button("Connect Google Drive", "btn-primary", async () => {
          if (isDemoMode()) {
            // Demo: the connect "just happens" — no OAuth, no popup.
            demoState.driveConfigured = true;
            await evaluate();
            return;
          }
          setMsg("ob-msg", "Connecting Google Drive…");
          try {
            await ensureDriveConnected();
            if (controller.isRunning()) {
              // Awaited (not fire-and-forget) so the iOS-eviction guard can steer to Restore: if
              // this Google account already holds a backup for a DIFFERENT wallet (the one this
              // device had before iOS evicted its storage), driveBackupNow throws instead of
              // overwriting it — and we send the user to restore that wallet rather than the fresh
              // seed they just created.
              await driveBackupNow(controller);
            }
            setMsg("ob-msg", "Cloud backup on ✓", "ok");
            await evaluate();
          } catch (e) {
            if (isDriveForeignBackupError(e)) {
              setMsg("ob-msg", (e as Error).message, "err");
              hideOverlay();
              renderedStep = "";
              showScreen("screen-restore");
              return;
            }
            setMsg("ob-msg", `Couldn't connect Google Drive: ${(e as Error).message}`, "err");
            await evaluate();
          }
        }),
      );
      return;
    }

    // channel
    body.innerHTML = `${emblem(ICONS.plus)}
      <h1>Get your first<br/>channel.</h1>
      <p>A channel is your lane on the Lightning Network — it's what lets you receive. You'll see the exact opening fee before anything is paid.</p>`;
    foot(
      button("Get a channel", "btn-primary", () => {
        hideOverlay();
        renderedStep = "";
        showScreen("screen-get-channel");
      }),
    );
  }

  onControllerEvent(() => {
    if (!done) void evaluate();
  });
  // Poll while incomplete: leaving a sub-screen (restore, get-channel) emits no wallet event,
  // and the gate must re-assert itself on home. Stops permanently once done.
  pollTimer = setInterval(() => {
    if (!done) void evaluate();
  }, 1500);
  void evaluate();
}
