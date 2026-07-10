import { describe, it, expect } from "vitest";
import { initialStack, push, pop, resetToRoot, current } from "./screen-router";

describe("screen-router stack", () => {
  it("starts at the root screen", () => {
    const s = initialStack("home");
    expect(current(s)).toBe("home");
  });

  it("pushes and pops screens immutably", () => {
    const s0 = initialStack("home");
    const s1 = push(s0, "receive");
    expect(current(s1)).toBe("receive");
    expect(current(s0)).toBe("home"); // original untouched
    const s2 = pop(s1);
    expect(current(s2)).toBe("home");
  });

  it("ignores a duplicate push of the current screen", () => {
    const s = push(push(initialStack("home"), "receive"), "receive");
    expect(s).toHaveLength(2);
  });

  it("never pops past the root", () => {
    const s = pop(pop(initialStack("home")));
    expect(current(s)).toBe("home");
    expect(s).toHaveLength(1);
  });

  it("resets to root from any depth", () => {
    const s = resetToRoot(push(push(initialStack("home"), "get-channel"), "channel-success"));
    expect(s).toEqual(["home"]);
  });
});
