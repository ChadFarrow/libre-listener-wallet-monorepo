import type { AppContext } from "../core/app-context";
import { emitControllerEvent } from "../core/events";
import { setSeedBackedUp } from "../core/onboarding";
import { registerScreen } from "../ui/nav";
import { $, setMsg, copyText } from "./util";

// Seed + 24-word phrase reveal. Secrets enter the DOM only on an explicit tap and are wiped
// when this screen is left (onHide) — never rendered at init or on state changes.

const MASK_HEX = "•".repeat(64);
const MASK_WORD = "••••••";

export function initRecoveryScreen(ctx: AppContext): void {
  const controller = ctx.controller;
  let words: string[] = [];
  let seedHex = "";

  async function loadSecrets(): Promise<void> {
    if (seedHex && words.length) return;
    const [{ seedHex: hex }, { mnemonic }] = await Promise.all([controller.getSeed(), controller.getRecoveryPhrase()]);
    seedHex = hex;
    words = mnemonic.split(" ");
  }

  async function markBackedUp(): Promise<void> {
    try {
      const { network } = await controller.getState();
      if (network) {
        setSeedBackedUp(network);
        emitControllerEvent("state-changed");
      }
    } catch {
      /* best-effort */
    }
  }

  function wipe(): void {
    seedHex = "";
    words = [];
    const hexEl = $("rec-hex");
    hexEl.textContent = MASK_HEX;
    hexEl.classList.add("masked");
    $("rec-hex-hint").textContent = "Tap to reveal";
    renderWords();
    $("rec-words-reveal").textContent = "Reveal all";
  }

  function renderWords(): void {
    const grid = $("rec-words");
    grid.innerHTML = "";
    for (let i = 0; i < 24; i++) {
      const b = document.createElement("button");
      b.className = "seed-word masked";
      const idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = String(i + 1);
      const w = document.createElement("span");
      w.className = "w";
      w.textContent = MASK_WORD;
      b.append(idx, w);
      b.addEventListener("click", () => {
        void (async () => {
          try {
            await loadSecrets();
          } catch (e) {
            setMsg("phrase-msg", (e as Error).message, "err");
            return;
          }
          const masked = b.classList.toggle("masked");
          w.textContent = masked ? MASK_WORD : words[i] ?? MASK_WORD;
          if (!masked) void markBackedUp();
        })();
      });
      grid.appendChild(b);
    }
  }

  const hexEl = $("rec-hex");
  hexEl.addEventListener("click", () => {
    void (async () => {
      const masked = hexEl.classList.contains("masked");
      if (masked) {
        try {
          await loadSecrets();
        } catch (e) {
          setMsg("phrase-msg", (e as Error).message, "err");
          return;
        }
        hexEl.textContent = seedHex;
        hexEl.classList.remove("masked");
        $("rec-hex-hint").textContent = "Tap to hide";
        void markBackedUp();
      } else {
        hexEl.textContent = MASK_HEX;
        hexEl.classList.add("masked");
        $("rec-hex-hint").textContent = "Tap to reveal";
      }
    })();
  });

  $("rec-hex-copy").addEventListener("click", () => {
    void (async () => {
      try {
        await loadSecrets();
      } catch (e) {
        setMsg("phrase-msg", (e as Error).message, "err");
        return;
      }
      const ok = await copyText(seedHex);
      setMsg("phrase-msg", ok ? "Seed copied — store it somewhere safe." : "Copy failed.", ok ? "ok" : "err");
      if (ok) void markBackedUp();
    })();
  });

  $("rec-words-reveal").addEventListener("click", () => {
    void (async () => {
      const grid = $("rec-words");
      const anyMasked = !!grid.querySelector(".seed-word.masked");
      if (anyMasked) {
        try {
          await loadSecrets();
        } catch (e) {
          setMsg("phrase-msg", (e as Error).message, "err");
          return;
        }
        void markBackedUp();
      }
      grid.querySelectorAll<HTMLElement>(".seed-word").forEach((b, i) => {
        b.classList.toggle("masked", !anyMasked);
        b.querySelector(".w")!.textContent = anyMasked ? words[i] ?? MASK_WORD : MASK_WORD;
      });
      $("rec-words-reveal").textContent = anyMasked ? "Hide all" : "Reveal all";
    })();
  });

  $("rec-words-copy").addEventListener("click", () => {
    void (async () => {
      try {
        await loadSecrets();
      } catch (e) {
        setMsg("phrase-msg", (e as Error).message, "err");
        return;
      }
      const ok = await copyText(words.join(" "));
      setMsg("phrase-msg", ok ? "Recovery phrase copied." : "Copy failed.", ok ? "ok" : "err");
      if (ok) void markBackedUp();
    })();
  });

  wipe();
  registerScreen("screen-recovery", {
    onShow: () => setMsg("phrase-msg", ""),
    onHide: () => wipe(), // secrets never persist in the DOM past this screen
  });
}
