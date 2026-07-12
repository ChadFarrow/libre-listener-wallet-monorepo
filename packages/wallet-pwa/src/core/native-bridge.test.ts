import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isNativeApp,
  getNativeForegroundService,
  createNativeKeepAlive,
  createKeepAliveForPlatform,
  type NativeForegroundService,
} from "./native-bridge";

const g = globalThis as unknown as {
  __LIBRE_NATIVE__?: boolean;
  Capacitor?: unknown;
  Audio?: unknown;
};

function clearNativeGlobals() {
  delete g.__LIBRE_NATIVE__;
  delete g.Capacitor;
}

describe("isNativeApp", () => {
  beforeEach(clearNativeGlobals);
  afterEach(clearNativeGlobals);

  it("is false in a plain browser/PWA (no flag, no Capacitor)", () => {
    expect(isNativeApp()).toBe(false);
  });

  it("honors the explicit __LIBRE_NATIVE__ flag", () => {
    g.__LIBRE_NATIVE__ = true;
    expect(isNativeApp()).toBe(true);
  });

  it("honors Capacitor.isNativePlatform() === true", () => {
    g.Capacitor = { isNativePlatform: () => true };
    expect(isNativeApp()).toBe(true);
  });

  it("stays false when Capacitor reports a web platform", () => {
    g.Capacitor = { isNativePlatform: () => false };
    expect(isNativeApp()).toBe(false);
  });
});

describe("getNativeForegroundService", () => {
  beforeEach(clearNativeGlobals);
  afterEach(clearNativeGlobals);

  it("returns null when the plugin isn't registered", () => {
    g.Capacitor = { Plugins: {} };
    expect(getNativeForegroundService()).toBeNull();
  });

  it("returns the plugin when it exposes start + stop", () => {
    const plugin = { start: () => {}, stop: () => {} };
    g.Capacitor = { Plugins: { LibreForegroundService: plugin } };
    expect(getNativeForegroundService()).toBe(plugin);
  });

  it("rejects a partial plugin missing stop()", () => {
    g.Capacitor = { Plugins: { LibreForegroundService: { start: () => {} } } };
    expect(getNativeForegroundService()).toBeNull();
  });
});

describe("createNativeKeepAlive", () => {
  it("delegates start/stop to the foreground service and tracks active", () => {
    const calls: string[] = [];
    const svc: NativeForegroundService = {
      start: () => {
        calls.push("start");
      },
      stop: () => {
        calls.push("stop");
      },
    };
    const ka = createNativeKeepAlive(svc);

    expect(ka.isActive()).toBe(false);
    ka.start();
    expect(calls).toEqual(["start"]);
    expect(ka.isActive()).toBe(true);
    ka.stop();
    expect(calls).toEqual(["start", "stop"]);
    expect(ka.isActive()).toBe(false);
  });

  it("never needs activation and unlock is a no-op (no autoplay gate)", () => {
    const svc: NativeForegroundService = { start: () => {}, stop: () => {} };
    const ka = createNativeKeepAlive(svc);
    ka.start();
    expect(ka.needsActivation()).toBe(false);
    expect(() => ka.unlock()).not.toThrow();
    expect(ka.isActive()).toBe(true); // unlock didn't disturb state
  });

  it("swallows an async start() rejection (fire-and-forget) without throwing", async () => {
    const svc: NativeForegroundService = {
      start: () => Promise.reject(new Error("service denied")),
      stop: () => {},
    };
    const ka = createNativeKeepAlive(svc);
    expect(() => ka.start()).not.toThrow();
    expect(ka.isActive()).toBe(true); // we optimistically mark active; the warn is logged async
    await Promise.resolve();
  });
});

describe("createKeepAliveForPlatform", () => {
  const OriginalAudio = (globalThis as unknown as { Audio?: unknown }).Audio;
  beforeEach(() => {
    clearNativeGlobals();
    // Stub Audio so the audio-keep-alive fallback can construct without a real DOM audio element.
    (globalThis as unknown as { Audio: unknown }).Audio = class {
      loop = false;
      play() {
        return Promise.resolve();
      }
      pause() {}
      setAttribute() {}
      addEventListener() {}
    };
  });
  afterEach(() => {
    clearNativeGlobals();
    (globalThis as unknown as { Audio?: unknown }).Audio = OriginalAudio;
  });

  it("returns the native keep-alive when native + plugin present", () => {
    const calls: string[] = [];
    g.__LIBRE_NATIVE__ = true;
    g.Capacitor = {
      Plugins: { LibreForegroundService: { start: () => calls.push("start"), stop: () => {} } },
    };
    const ka = createKeepAliveForPlatform();
    ka.start();
    expect(calls).toEqual(["start"]); // proves it's the native impl, not the audio one
    expect(ka.needsActivation()).toBe(false);
  });

  it("falls back to audio keep-alive in a plain browser", () => {
    const ka = createKeepAliveForPlatform();
    // The audio impl needs a gesture to activate (needsActivation becomes true once wanted-but-blocked).
    expect(ka.isActive()).toBe(false);
    expect(() => ka.start()).not.toThrow();
  });

  it("falls back to audio keep-alive when native but the plugin is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    g.__LIBRE_NATIVE__ = true;
    g.Capacitor = { Plugins: {} };
    const ka = createKeepAliveForPlatform();
    expect(ka).toBeTruthy();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
