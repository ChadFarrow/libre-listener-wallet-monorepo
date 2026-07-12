// Inaudible-audio keep-alive. Plays a short looping clip so iOS/Android treat the page as "playing
// media" and keep it (and its single foreground LDK node) alive while backgrounded — so NWC boosts
// settle in real time instead of only when the wallet is reopened.
//
// Why a REAL (but sub-audible) waveform, not pure digital silence: iOS's audio engine treats an
// all-zero track as "nothing playing" and suspends it, so a truly-silent loop does NOT hold the
// session — the node still froze in the background. Native wallets that keep alive this way
// (Zeus, Primal) play genuine audio through their audio session; that's why theirs shows in the
// iOS Now Playing island. We can't set an iOS audio-session category from a PWA, so we get the
// same "real signal" effect by playing an extremely quiet tone (~-72 dBFS) — inaudible to a
// listener (that's the "muted" part) but a real signal the OS won't optimize away.
//
// BEST-EFFORT, not a guarantee: the OS can still suspend it under memory pressure, and Android OEM
// battery killers (Samsung/Xiaomi/…) are aggressive — an always-on node + NWC client is the only
// rock-solid path. Because it keeps the ONE existing node alive (never spawns a second), there is
// NO force-close risk — unlike the old service-worker background node.
//
// iOS caveat we cannot fix from a PWA: a playing <audio> element uses the "playback" audio session,
// which can claim the Now Playing slot and interrupt other apps' audio — there is no web API to
// request mixWithOthers. The tiny amplitude keeps it inaudible but does not make it mix.
//
// Autoplay policy: audio.play() must first be called from a user gesture. We try immediately; if the
// browser blocks it (e.g. an auto-start with no gesture), we arm a one-shot first-gesture retry.

export interface KeepAlive {
  start(): void;
  stop(): void;
  // Prime the audio element from within a user gesture so a later programmatic start() is allowed
  // by iOS. Call from a first-tap handler — one tap anywhere then activates keep-alive.
  unlock(): void;
  isActive(): boolean;
  // True when keep-alive is WANTED (enabled + node running) but not yet playing — i.e. it's waiting
  // for a user tap to satisfy iOS's autoplay gate. Drives a "tap to keep alive" UI hint.
  needsActivation(): boolean;
}

// Peak amplitude of the keep-alive tone, in 16-bit PCM counts. 8/32768 ≈ -72 dBFS — a real signal
// the OS won't treat as silence, but far below the threshold of hearing on any phone output.
export const KEEP_ALIVE_PEAK_AMPLITUDE = 8;

// Build a valid 1-second 16-bit PCM WAV as a data URI at runtime (no opaque base64 blob). The
// content is an extremely quiet low tone: a real (non-zero) signal so iOS keeps the audio session
// alive, but inaudible in practice. 40 cycles over exactly 1s (40 Hz) so the loop is seamless.
export function inaudibleWavDataUri(): string {
  const sampleRate = 8000;
  const samples = sampleRate; // 1s
  const bytesPerSample = 2; // 16-bit mono
  const dataSize = samples * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  const cyclesPerSecond = 40; // integer cycles over the 1s buffer → seamless loop, no click
  for (let i = 0; i < samples; i++) {
    const sample = Math.round(KEEP_ALIVE_PEAK_AMPLITUDE * Math.sin((2 * Math.PI * cyclesPerSecond * i) / sampleRate));
    view.setInt16(44 + i * bytesPerSample, sample, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(bin);
}

export function createKeepAlive(): KeepAlive {
  let audio: HTMLAudioElement | null = null;
  let armed = false;
  let active = false;
  let wanted = false; // keep-alive is enabled + the node is running (so it SHOULD be playing)
  let loggedBlocked = false; // log "blocked" once per episode, not on every controller event

  const ensureAudio = (): HTMLAudioElement => {
    if (!audio) {
      audio = new Audio(inaudibleWavDataUri());
      audio.loop = true;
      audio.setAttribute("playsinline", ""); // iOS: don't force fullscreen playback
    }
    return audio;
  };
  const onGesture = () => {
    detach();
    tryPlay();
  };
  const armGesture = () => {
    if (armed) return;
    armed = true;
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
  };
  const detach = () => {
    armed = false;
    window.removeEventListener("pointerdown", onGesture);
    window.removeEventListener("keydown", onGesture);
  };
  const tryPlay = () => {
    ensureAudio()
      .play()
      .then(() => {
        active = true;
        loggedBlocked = false;
        // Logged so a diagnostics export confirms the keep-alive is actually holding the page
        // alive (vs. silently blocked/suspended) — the page-lifecycle stamps tell the rest.
        console.log("[KeepAlive] playing inaudible tone — page kept alive while backgrounded");
      })
      .catch(() => {
        // iOS blocks play() outside a user gesture. Arm a first-interaction retry and say so ONCE
        // (this path fires on every controller event, so guard the log to avoid flooding the trace).
        if (!loggedBlocked) {
          loggedBlocked = true;
          console.log("[KeepAlive] play blocked — needs one screen tap to activate; armed first-tap retry");
        }
        armGesture();
      });
  };

  return {
    start(): void {
      wanted = true;
      tryPlay();
    },
    stop(): void {
      wanted = false;
      detach();
      loggedBlocked = false;
      if (audio) {
        audio.pause();
        active = false;
        console.log("[KeepAlive] stopped");
      }
    },
    unlock(): void {
      // Called from the app's first user gesture (e.g. tapping "Start node"): play() inside the
      // gesture so iOS marks the element "unlocked", then a later programmatic start() is allowed.
      // If keep-alive is wanted right now, this doubles as the activating play; otherwise unlock and
      // pause so the element is primed for when the node comes up.
      const a = ensureAudio();
      a.play()
        .then(() => {
          if (wanted) {
            active = true;
            loggedBlocked = false;
            console.log("[KeepAlive] activated by user tap");
          } else {
            a.pause(); // primed only — nothing to keep alive yet
          }
        })
        .catch(() => {
          /* not a trusted gesture (e.g. programmatic call) — ignore; a real tap will prime it */
        });
    },
    isActive(): boolean {
      return active;
    },
    needsActivation(): boolean {
      return wanted && !active;
    },
  };
}
