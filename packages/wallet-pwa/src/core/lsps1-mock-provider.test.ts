import { describe, it, expect } from "vitest";
import { LSPS1_REST_PROVIDERS } from "@libre/shared";
import { withMockProvider, quickChannelProvider } from "./lsps1-mock-provider";

describe("withMockProvider", () => {
  it("returns the real providers untouched when no mock URL is set", () => {
    expect(withMockProvider(LSPS1_REST_PROVIDERS, undefined)).toBe(LSPS1_REST_PROVIDERS);
    expect(withMockProvider(LSPS1_REST_PROVIDERS, "")).toBe(LSPS1_REST_PROVIDERS);
    expect(withMockProvider(LSPS1_REST_PROVIDERS, "   ")).toBe(LSPS1_REST_PROVIDERS);
  });

  it("layers a mock entry pointing at the given URL when set", () => {
    const url = "http://127.0.0.1:9098/mock-lsps1/v1";
    const p = withMockProvider(LSPS1_REST_PROVIDERS, url);
    expect(p.mock).toBeDefined();
    expect(p.mock.restBaseUrl).toBe(url);
    // Real providers stay available alongside the mock.
    expect(p.megalith).toBe(LSPS1_REST_PROVIDERS.megalith);
    expect(p.olympus).toBe(LSPS1_REST_PROVIDERS.olympus);
    // The source map is not mutated.
    expect(LSPS1_REST_PROVIDERS.mock).toBeUndefined();
  });

  it("mock provider has no nodePubkey, so it can never enter the 0-conf trust allowlist", () => {
    const p = withMockProvider(LSPS1_REST_PROVIDERS, "http://127.0.0.1:9098/mock-lsps1/v1");
    expect(p.mock.nodePubkey).toBeUndefined();
  });

  it("mock bounds match the quick-channel order size (150k fits)", () => {
    const p = withMockProvider(LSPS1_REST_PROVIDERS, "http://127.0.0.1:9098/mock-lsps1/v1");
    expect(p.mock.minChannelSat).toBeLessThanOrEqual(150_000);
    expect(p.mock.maxChannelSat).toBeGreaterThanOrEqual(150_000);
  });
});

describe("quickChannelProvider", () => {
  it("uses Megalith when no mock is configured", () => {
    expect(quickChannelProvider(LSPS1_REST_PROVIDERS)).toBe(LSPS1_REST_PROVIDERS.megalith);
  });

  it("prefers the mock when it is present", () => {
    const p = withMockProvider(LSPS1_REST_PROVIDERS, "http://127.0.0.1:9098/mock-lsps1/v1");
    expect(quickChannelProvider(p)).toBe(p.mock);
  });
});
