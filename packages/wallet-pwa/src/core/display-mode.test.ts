import { describe, it, expect } from "vitest";
import { isStandaloneDisplayFrom } from "./display-mode";

describe("isStandaloneDisplayFrom", () => {
  it("is true when the display-mode media query matches (any installed PWA)", () => {
    expect(isStandaloneDisplayFrom({ standaloneMatch: true })).toBe(true);
  });

  it("is true when iOS legacy navigator.standalone is set", () => {
    expect(isStandaloneDisplayFrom({ standaloneMatch: false, navStandalone: true })).toBe(true);
  });

  it("is false in a normal browser tab (neither signal)", () => {
    expect(isStandaloneDisplayFrom({ standaloneMatch: false })).toBe(false);
    expect(isStandaloneDisplayFrom({ standaloneMatch: false, navStandalone: false })).toBe(false);
  });
});
