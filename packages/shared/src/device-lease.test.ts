import { describe, it, expect } from "vitest";
import {
  evaluateDeviceLease,
  isCrossDeviceLockError,
  SINGLE_DEVICE_VIOLATION_CODE,
  type DeviceLeaseRecord,
} from "./device-lease";

const lease = (owner: string, expiresAt: number): DeviceLeaseRecord => ({ owner, acquiredAt: 0, expiresAt });

describe("evaluateDeviceLease", () => {
  const NOW = 1_000_000;

  it("acquires when there is no existing lease", () => {
    expect(evaluateDeviceLease(null, "me", NOW)).toBe("acquire");
    expect(evaluateDeviceLease(undefined, "me", NOW)).toBe("acquire");
  });

  it("renews when the existing lease is ours (a restart of the same device)", () => {
    expect(evaluateDeviceLease(lease("me", NOW + 60_000), "me", NOW)).toBe("renew");
  });

  it("is BLOCKED when another device holds a still-live lease", () => {
    expect(evaluateDeviceLease(lease("other", NOW + 60_000), "me", NOW)).toBe("blocked");
  });

  it("takes over (acquire) when another device's lease has expired (crashed holder)", () => {
    expect(evaluateDeviceLease(lease("other", NOW - 1), "me", NOW)).toBe("acquire");
    expect(evaluateDeviceLease(lease("other", NOW), "me", NOW)).toBe("acquire"); // exactly at expiry
  });
});

describe("isCrossDeviceLockError", () => {
  it("matches on the code field, the message token, and a bare string", () => {
    expect(isCrossDeviceLockError({ code: SINGLE_DEVICE_VIOLATION_CODE })).toBe(true);
    expect(isCrossDeviceLockError({ message: `[${SINGLE_DEVICE_VIOLATION_CODE}] running elsewhere` })).toBe(true);
    expect(isCrossDeviceLockError(SINGLE_DEVICE_VIOLATION_CODE)).toBe(true);
    expect(isCrossDeviceLockError(new Error("something else"))).toBe(false);
    expect(isCrossDeviceLockError(null)).toBe(false);
  });
});
