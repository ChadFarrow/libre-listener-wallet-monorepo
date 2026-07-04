import { describe, it, expect } from "vitest";
import { bridgeTargetUrl } from "./index";

describe("bridgeTargetUrl", () => {
  it("appends target with ? when the base has no query", () => {
    expect(bridgeTargetUrl("wss://b.up.railway.app", "64.23.162.51", 9735)).toBe(
      "wss://b.up.railway.app?target=64.23.162.51%3A9735"
    );
  });
  it("appends target with & when the base already has a query", () => {
    expect(bridgeTargetUrl("wss://b/path?x=1", "1.2.3.4", 9735)).toBe(
      "wss://b/path?x=1&target=1.2.3.4%3A9735"
    );
  });
  it("keeps a trailing slash and works for ws:// dev bridges", () => {
    expect(bridgeTargetUrl("ws://127.0.0.1:8085/", "5.6.7.8", 9736)).toBe(
      "ws://127.0.0.1:8085/?target=5.6.7.8%3A9736"
    );
  });
});
