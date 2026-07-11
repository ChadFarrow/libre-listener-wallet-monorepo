import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { silentWavDataUri, createKeepAlive } from "./keep-alive-audio";

describe("silentWavDataUri", () => {
  it("is a base64 WAV data URI with a valid RIFF/WAVE header of silence", () => {
    const uri = silentWavDataUri();
    expect(uri.startsWith("data:audio/wav;base64,")).toBe(true);
    const bin = atob(uri.slice("data:audio/wav;base64,".length));
    expect(bin.slice(0, 4)).toBe("RIFF");
    expect(bin.slice(8, 12)).toBe("WAVE");
    // 8-bit PCM silence is 0x80; the sample region (after the 44-byte header) must be all silence.
    expect(bin.charCodeAt(44)).toBe(128);
    expect(bin.charCodeAt(bin.length - 1)).toBe(128);
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
