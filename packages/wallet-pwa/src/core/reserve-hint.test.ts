import { describe, it, expect } from "vitest";
import { firstTopUpHint } from "./reserve-hint";

describe("firstTopUpHint", () => {
  it("recommends a first top-up comfortably above the ~1% reserve of a 100k channel", () => {
    const h = firstTopUpHint({ spendableSat: 0, usableChannelCapacitiesSat: [100_000] });
    expect(h).toEqual({ reserveSat: 1000, recommendedSat: 5000 });
  });

  it("scales with a bigger channel (1M → 10k reserve, 20k recommended)", () => {
    const h = firstTopUpHint({ spendableSat: 0, usableChannelCapacitiesSat: [1_000_000] });
    expect(h).toEqual({ reserveSat: 10_000, recommendedSat: 20_000 });
  });

  it("uses the largest usable channel when there are several", () => {
    const h = firstTopUpHint({ spendableSat: 0, usableChannelCapacitiesSat: [100_000, 250_000] });
    expect(h?.reserveSat).toBe(2500);
  });

  it("goes away once there is any spendable balance (reserve already filled)", () => {
    expect(firstTopUpHint({ spendableSat: 5000, usableChannelCapacitiesSat: [100_000] })).toBeUndefined();
    expect(firstTopUpHint({ spendableSat: 1, usableChannelCapacitiesSat: [100_000] })).toBeUndefined();
  });

  it("no hint without a usable channel", () => {
    expect(firstTopUpHint({ spendableSat: 0, usableChannelCapacitiesSat: [] })).toBeUndefined();
  });
});
