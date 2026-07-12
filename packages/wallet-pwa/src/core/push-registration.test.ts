import { describe, it, expect } from "vitest";
import {
  parsePushWakePrefs,
  serializePushWakePrefs,
  shouldRefreshPushRegistration,
  effectivePushPrefs,
  permissionDeniedMessage,
  pushSubscribeFailedMessage,
  DEFAULT_PUSH_GATEWAY_URL,
  DEFAULT_PUSH_RELAY_URL,
  type PushWakePrefs,
} from "./push-registration";

const prefs: PushWakePrefs = { gatewayUrl: "https://gw.example", relayUrl: "wss://relay.example/v1" };

describe("push-registration prefs", () => {
  it("round-trips serialize → parse", () => {
    expect(parsePushWakePrefs(serializePushWakePrefs(prefs))).toEqual(prefs);
  });

  it("parse returns null for absent / corrupt / incomplete values", () => {
    expect(parsePushWakePrefs(null)).toBeNull();
    expect(parsePushWakePrefs("")).toBeNull();
    expect(parsePushWakePrefs("{not json")).toBeNull();
    expect(parsePushWakePrefs(JSON.stringify({ gatewayUrl: "https://gw.example" }))).toBeNull(); // no relay
    expect(parsePushWakePrefs(JSON.stringify({ gatewayUrl: "", relayUrl: "wss://r" }))).toBeNull(); // empty
  });

  it("serialize keeps only the two known fields", () => {
    const out = JSON.parse(serializePushWakePrefs({ ...prefs, extra: "x" } as unknown as PushWakePrefs));
    expect(out).toEqual(prefs);
  });
});

describe("shouldRefreshPushRegistration", () => {
  const base = { prefs, supported: true, permission: "granted" as NotificationPermission, running: true };

  it("attempts only when all conditions hold", () => {
    expect(shouldRefreshPushRegistration(base)).toBe(true);
  });

  it("skips when the user never enabled wake (no prefs)", () => {
    expect(shouldRefreshPushRegistration({ ...base, prefs: null })).toBe(false);
  });

  it("skips when push is unsupported", () => {
    expect(shouldRefreshPushRegistration({ ...base, supported: false })).toBe(false);
  });

  it("never prompts: skips when permission is not already granted", () => {
    expect(shouldRefreshPushRegistration({ ...base, permission: "default" })).toBe(false);
    expect(shouldRefreshPushRegistration({ ...base, permission: "denied" })).toBe(false);
  });

  it("skips when the node isn't running (can't sign the gateway auth)", () => {
    expect(shouldRefreshPushRegistration({ ...base, running: false })).toBe(false);
  });
});

describe("permissionDeniedMessage", () => {
  it("gives an unblock-in-settings path for 'denied' (re-prompt won't fire)", () => {
    const msg = permissionDeniedMessage("denied");
    expect(msg).toMatch(/site settings|Notifications/i);
    expect(msg).toMatch(/Brave/);
    // Names the Play-Services dependency so GrapheneOS / de-Googled users aren't chasing a config
    // that can't exist for them, and points at the push-free fallback.
    expect(msg).toMatch(/Play/);
    expect(msg).toMatch(/GrapheneOS|de-Googled/);
    expect(msg).toMatch(/Background mode/);
    // Must NOT tell a denied user to just 'tap Enable again' as the fix — that dead-ends.
    expect(msg).not.toMatch(/prompt was dismissed/i);
  });

  it("tells a 'default' (dismissed) user to retry the prompt", () => {
    const msg = permissionDeniedMessage("default");
    expect(msg).toMatch(/dismissed/i);
    expect(msg).toMatch(/again/i);
  });
});

describe("pushSubscribeFailedMessage", () => {
  it("names the Play-Services dependency, Brave's setting, and the push-free fallback", () => {
    const msg = pushSubscribeFailedMessage();
    expect(msg).toMatch(/Brave/);
    expect(msg).toMatch(/Google Play Services/);
    expect(msg).toMatch(/GrapheneOS|de-Googled/);
    expect(msg).toMatch(/Background mode/);
  });
});

describe("effectivePushPrefs (legacy migration)", () => {
  it("returns stored prefs when present, ignoring the subscription", () => {
    expect(effectivePushPrefs({ stored: prefs, hasLiveSubscription: false })).toEqual(prefs);
  });

  it("backfills ship defaults for a pre-prefs install with a live subscription", () => {
    expect(effectivePushPrefs({ stored: null, hasLiveSubscription: true })).toEqual({
      gatewayUrl: DEFAULT_PUSH_GATEWAY_URL,
      relayUrl: DEFAULT_PUSH_RELAY_URL,
    });
  });

  it("returns null when wake was never enabled (no prefs, no subscription)", () => {
    expect(effectivePushPrefs({ stored: null, hasLiveSubscription: false })).toBeNull();
  });
});
