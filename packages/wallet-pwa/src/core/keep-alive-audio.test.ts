import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { inaudibleWavDataUri, KEEP_ALIVE_PEAK_AMPLITUDE, createKeepAlive } from "./keep-alive-audio";

describe("inaudibleWavDataUri", () => {
  it("is a base64 WAV data URI with a valid 16-bit PCM RIFF/WAVE header", () => {
    const uri = inaudibleWavDataUri();
    expect(uri.startsWith("data:audio/wav;base64,")).toBe(true);
    const bin = atob(uri.slice("data:audio/wav;base64,".length));
    expect(bin.slice(0, 4)).toBe("RIFF");
    expect(bin.slice(8, 12)).toBe("WAVE");
    expect(bin.charCodeAt(34)).toBe(16); // 16 bits per sample
  });

  it("carries a REAL non-zero signal (iOS suspends a pure-silence track) but keeps it sub-audible", () => {
    const uri = inaudibleWavDataUri();
    const bin = atob(uri.slice("data:audio/wav;base64,".length));
    let peak = 0;
    for (let off = 44; off + 1 < bin.length; off += 2) {
      // little-endian signed 16-bit
      let v = bin.charCodeAt(off) | (bin.charCodeAt(off + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0); // not pure silence — the whole point of the fix
    expect(peak).toBeLessThanOrEqual(KEEP_ALIVE_PEAK_AMPLITUDE); // ~-72 dBFS, inaudible ("muted")
  });
});

describe("createKeepAlive", () => {
  let played = 0;
  let paused = 0;
  const OriginalAudio = globalThis.Audio;

  beforeEach(() => {
    played = 0;
    paused = 0;
    // Mock Audio: play() resolves (autoplay allowed), pause() counts.
    (globalThis as any).Audio = class {
      loop = false;
      play() {
        played++;
        return Promise.resolve();
      }
      pause() {
        paused++;
      }
      setAttribute() {}
    };
  });
  afterEach(() => {
    (globalThis as any).Audio = OriginalAudio;
  });

  it("plays on start and pauses on stop, and reports active", async () => {
    const ka = createKeepAlive();
    ka.start();
    await Promise.resolve();
    expect(played).toBe(1);
    expect(ka.isActive()).toBe(true);
    ka.stop();
    expect(paused).toBe(1);
    expect(ka.isActive()).toBe(false);
  });

  it("reuses one audio element across start calls (no leak of elements)", async () => {
    const ka = createKeepAlive();
    ka.start();
    ka.start();
    await Promise.resolve();
    expect(played).toBe(2); // same element, played twice — not two elements
  });
});
