import { describe, it, expect } from "vitest";
import {
  parsePushWakePrefs,
  serializePushWakePrefs,
  shouldRefreshPushRegistration,
  effectivePushPrefs,
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
