import { describe, it, expect, beforeEach } from "vitest";
import { loadLastBalanceSats, saveLastBalanceSats } from "./balance-cache";

describe("balance cache", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when nothing is cached", () => {
    expect(loadLastBalanceSats()).toBeNull();
  });

  it("round-trips a value", () => {
    saveLastBalanceSats(4200);
    expect(loadLastBalanceSats()).toBe(4200);
  });

  it("truncates a fractional value", () => {
    saveLastBalanceSats(4200.9);
    expect(loadLastBalanceSats()).toBe(4200);
  });

  it("persists a genuine zero", () => {
    saveLastBalanceSats(0);
    expect(loadLastBalanceSats()).toBe(0);
  });

  it("ignores a negative or non-finite value", () => {
    saveLastBalanceSats(-1);
    expect(loadLastBalanceSats()).toBeNull();
    saveLastBalanceSats(Number.NaN);
    expect(loadLastBalanceSats()).toBeNull();
  });

  it("returns null on a corrupt cached string", () => {
    localStorage.setItem("libre_last_balance_sats", "not-a-number");
    expect(loadLastBalanceSats()).toBeNull();
  });
});
