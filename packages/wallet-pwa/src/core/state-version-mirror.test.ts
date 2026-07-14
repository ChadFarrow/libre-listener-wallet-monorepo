import { describe, it, expect } from "vitest";
import {
  nextMirrorValue,
  localStateRolledBack,
  StateRollbackError,
  isStateRollbackError,
  mirrorKeyForNetwork,
  STATE_ROLLBACK_CODE,
} from "./state-version-mirror";

describe("mirrorKeyForNetwork", () => {
  it("is per-network and defaults a blank network to mainnet", () => {
    expect(mirrorKeyForNetwork("mainnet")).toBe("libre_state_version_hwm:mainnet");
    expect(mirrorKeyForNetwork("testnet")).toBe("libre_state_version_hwm:testnet");
    expect(mirrorKeyForNetwork("")).toBe("libre_state_version_hwm:mainnet");
  });
});

describe("nextMirrorValue (high-water)", () => {
  it("never lets the mirror decrease", () => {
    expect(nextMirrorValue(90, 113)).toBe(113); // the incident: on-disk rolled back, mirror holds
    expect(nextMirrorValue(114, 113)).toBe(114); // normal advance
    expect(nextMirrorValue(113, 113)).toBe(113);
    expect(nextMirrorValue(5, null)).toBe(5); // first record — no prior mirror
    expect(nextMirrorValue(null, 7)).toBe(7); // missing current read — keep the mirror
  });

  it("coerces junk/negative/NaN to 0", () => {
    expect(nextMirrorValue(NaN, 4)).toBe(4);
    expect(nextMirrorValue("8", "3")).toBe(8); // decimal strings from storage
    expect(nextMirrorValue(-2, -9)).toBe(0);
    expect(nextMirrorValue(2.9, 1.1)).toBe(2); // floored
  });
});

describe("localStateRolledBack", () => {
  it("is true only when the mirror is strictly ahead of local", () => {
    expect(localStateRolledBack(90, 113)).toBe(true); // the incident
    expect(localStateRolledBack(113, 113)).toBe(false); // in sync
    expect(localStateRolledBack(114, 113)).toBe(false); // local ahead — mirror just lagged; re-seed, don't halt
    expect(localStateRolledBack(0, 0)).toBe(false); // fresh wallet / no mirror yet
    expect(localStateRolledBack(5, null)).toBe(false); // no mirror recorded → never halts
  });

  it("coerces junk so a missing/garbage value can't mis-trigger", () => {
    expect(localStateRolledBack(NaN, 3)).toBe(true); // local unknown, mirror has state → treat local as 0
    expect(localStateRolledBack(3, NaN)).toBe(false); // mirror unknown → never halt
    expect(localStateRolledBack("90", "113")).toBe(true);
  });
});

describe("StateRollbackError", () => {
  it("carries a boundary-stable code, the versions, and a code token in the message", () => {
    const e = new StateRollbackError(90, 113);
    expect(e.code).toBe(STATE_ROLLBACK_CODE);
    expect(e.localVersion).toBe(90);
    expect(e.mirrorVersion).toBe(113);
    expect(e.message).toContain(`[${STATE_ROLLBACK_CODE}]`);
    expect(isStateRollbackError(e)).toBe(true);
  });

  it("isStateRollbackError matches a flattened error via the message token (cross-boundary)", () => {
    expect(isStateRollbackError({ message: `nope [${STATE_ROLLBACK_CODE}]` })).toBe(true);
    expect(isStateRollbackError({ code: STATE_ROLLBACK_CODE })).toBe(true);
    expect(isStateRollbackError(new Error("unrelated"))).toBe(false);
    expect(isStateRollbackError(undefined)).toBe(false);
    expect(isStateRollbackError("STATE_ROLLBACK")).toBe(false);
  });
});
