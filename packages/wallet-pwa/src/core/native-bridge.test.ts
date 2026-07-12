import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isNativeApp,
  getNativeForegroundService,
  createNativeKeepAlive,
  createKeepAliveForPlatform,
  ensureOverlayPermission,
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

  it("is transition-gated: repeated start()/stop() (one per controller event) cross the bridge once", () => {
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
    ka.start();
    ka.start();
    ka.start();
    expect(calls).toEqual(["start"]);
    ka.stop();
    ka.stop();
    expect(calls).toEqual(["start", "stop"]);
    ka.start();
    expect(calls).toEqual(["start", "stop", "start"]);
  });

  it("first stop() still crosses the bridge (cleans up a service orphaned by a sticky restart)", () => {
    const calls: string[] = [];
    const svc: NativeForegroundService = {
      start: () => {},
      stop: () => {
        calls.push("stop");
      },
    };
    const ka = createNativeKeepAlive(svc);
    ka.stop(); // never started in this page's lifetime — still send the stop
    expect(calls).toEqual(["stop"]);
  });

  it("clears active when start() rejects, then retries on the next start()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const calls: string[] = [];
    const svc: NativeForegroundService = {
      start: () => {
        calls.push("start");
        return fail ? Promise.reject(new Error("service denied")) : Promise.resolve();
      },
      stop: () => {},
    };
    const ka = createNativeKeepAlive(svc);
    expect(() => ka.start()).not.toThrow();
    expect(ka.isActive()).toBe(true); // optimistic until the bridge answers
    // The rejection must clear active — otherwise the chip claims "Background mode on" forever
    // while no foreground service is actually holding the process.
    await vi.waitFor(() => expect(ka.isActive()).toBe(false));
    expect(warn).toHaveBeenCalledOnce();

    fail = false;
    ka.start(); // next controller event retries (the failed attempt un-latched the transition gate)
    expect(calls).toEqual(["start", "start"]);
    await vi.waitFor(() => expect(ka.isActive()).toBe(true));
    warn.mockRestore();
  });
});

describe("ensureOverlayPermission", () => {
  beforeEach(clearNativeGlobals);
  afterEach(clearNativeGlobals);

  it("is a no-op in a plain browser/PWA (not native)", async () => {
    let called = false;
    g.Capacitor = {
      Plugins: {
        LibreForegroundService: {
          start: () => {},
          stop: () => {},
          hasOverlayPermission: async () => {
            called = true;
            return { granted: false };
          },
          requestOverlayPermission: async () => {},
        },
      },
    };
    // isNativeApp() is false (no __LIBRE_NATIVE__, no isNativePlatform) so it must not touch the plugin.
    await ensureOverlayPermission();
    expect(called).toBe(false);
  });

  it("requests the permission when native + not granted", async () => {
    const calls: string[] = [];
    g.__LIBRE_NATIVE__ = true;
    g.Capacitor = {
      Plugins: {
        LibreForegroundService: {
          start: () => {},
          stop: () => {},
          hasOverlayPermission: async () => {
            calls.push("check");
            return { granted: false };
          },
          requestOverlayPermission: async () => {
            calls.push("request");
          },
        },
      },
    };
    await ensureOverlayPermission();
    expect(calls).toEqual(["check", "request"]);
  });

  it("does NOT request when already granted", async () => {
    const calls: string[] = [];
    g.__LIBRE_NATIVE__ = true;
    g.Capacitor = {
      Plugins: {
        LibreForegroundService: {
          start: () => {},
          stop: () => {},
          hasOverlayPermission: async () => {
            calls.push("check");
            return { granted: true };
          },
          requestOverlayPermission: async () => {
            calls.push("request");
          },
        },
      },
    };
    await ensureOverlayPermission();
    expect(calls).toEqual(["check"]);
  });

  it("is a safe no-op when native but the plugin lacks the overlay methods (older wrapper)", async () => {
    g.__LIBRE_NATIVE__ = true;
    g.Capacitor = { Plugins: { LibreForegroundService: { start: () => {}, stop: () => {} } } };
    await expect(ensureOverlayPermission()).resolves.toBeUndefined();
  });

  it("swallows a rejection from the permission check without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    g.__LIBRE_NATIVE__ = true;
    g.Capacitor = {
      Plugins: {
        LibreForegroundService: {
          start: () => {},
          stop: () => {},
          hasOverlayPermission: async () => {
            throw new Error("bridge error");
          },
          requestOverlayPermission: async () => {},
        },
      },
    };
    await expect(ensureOverlayPermission()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
