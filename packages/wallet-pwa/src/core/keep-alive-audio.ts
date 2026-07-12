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
  isActive(): boolean;
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

  const onGesture = () => {
    detach();
    if (audio) tryPlay();
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
    if (!audio) return;
    audio
      .play()
      .then(() => {
        active = true;
      })
      .catch(() => {
        // Blocked by the autoplay policy (no gesture yet) — retry on the first user interaction.
        armGesture();
      });
  };

  return {
    start(): void {
      if (!audio) {
        audio = new Audio(inaudibleWavDataUri());
        audio.loop = true;
        audio.setAttribute("playsinline", ""); // iOS: don't force fullscreen playback
      }
      tryPlay();
    },
    stop(): void {
      detach();
      if (audio) {
        audio.pause();
        active = false;
      }
    },
    isActive(): boolean {
      return active;
    },
  };
}
