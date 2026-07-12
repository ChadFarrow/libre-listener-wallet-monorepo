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
  let lastAudio: any = null;
  const OriginalAudio = globalThis.Audio;

  beforeEach(() => {
    played = 0;
    paused = 0;
    lastAudio = null;
    // Mock Audio: play() resolves (autoplay allowed) and fires nothing; pause() counts and fires
    // registered "pause" listeners (mirrors how the browser notifies us of an audio-focus loss).
    (globalThis as any).Audio = class {
      loop = false;
      listeners: Record<string, Array<() => void>> = {};
      constructor() {
        lastAudio = this;
      }
      play() {
        played++;
        return Promise.resolve();
      }
      pause() {
        paused++;
        (this.listeners.pause || []).forEach((cb) => cb());
      }
      setAttribute() {}
      addEventListener(type: string, cb: () => void) {
        (this.listeners[type] ||= []).push(cb);
      }
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

  it("needsActivation is true when wanted but blocked, false once playing", async () => {
    // Blocked-play mock: play() rejects until a gesture "unlocks" it.
    let unlocked = false;
    (globalThis as any).Audio = class {
      loop = false;
      play() { return unlocked ? Promise.resolve() : Promise.reject(new Error("NotAllowed")); }
      pause() {}
      setAttribute() {}
      addEventListener() {}
    };
    const ka = createKeepAlive();
    ka.start();
    await Promise.resolve(); await Promise.resolve();
    expect(ka.isActive()).toBe(false);
    expect(ka.needsActivation()).toBe(true); // wanted, but iOS blocked it → hint should show
    // A user gesture unlocks the element; unlock() while wanted activates it.
    unlocked = true;
    ka.unlock();
    await Promise.resolve(); await Promise.resolve();
    expect(ka.isActive()).toBe(true);
    expect(ka.needsActivation()).toBe(false);
  });

  it("goes inactive when the OS/another app pauses the tone (audio focus lost)", async () => {
    const ka = createKeepAlive();
    ka.start();
    await Promise.resolve();
    expect(ka.isActive()).toBe(true);
    expect(ka.needsActivation()).toBe(false);
    // Android pauses our tone when a podcast app grabs audio focus. We must notice — otherwise the
    // chip keeps claiming "Background mode on" while the page is actually frozen.
    lastAudio.pause();
    expect(ka.isActive()).toBe(false);
    expect(ka.needsActivation()).toBe(true); // wanted again but no longer playing → re-arm hint
  });

  it("unlock() while NOT wanted primes the element without leaving it playing", async () => {
    const ka = createKeepAlive();
    ka.unlock(); // no start() yet → not wanted
    await Promise.resolve(); await Promise.resolve();
    expect(ka.isActive()).toBe(false);
    expect(paused).toBe(1); // played to unlock, then paused
  });

  it("reuses one audio element across start calls (no leak of elements)", async () => {
    const ka = createKeepAlive();
    ka.start();
    ka.start();
    await Promise.resolve();
    expect(played).toBe(2); // same element, played twice — not two elements
  });
});
