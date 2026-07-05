import { describe, it, expect } from "vitest";
import { zeroConfTrustedPubkeys, LSPS1_REST_PROVIDERS, type Lsps1RestProvider } from "./index";

describe("zeroConfTrustedPubkeys", () => {
  it("returns the node pubkeys of providers that offer 0-conf (Megalith), not confirmed-only ones (Olympus)", () => {
    const keys = zeroConfTrustedPubkeys();
    expect(keys).toContain(LSPS1_REST_PROVIDERS.megalith.nodePubkey);
    expect(keys).not.toContain(LSPS1_REST_PROVIDERS.olympus.nodePubkey);
  });
  it("skips a 0-conf provider with no known pubkey (can't allowlist what we can't match)", () => {
    const providers: Record<string, Lsps1RestProvider> = {
      a: { ...LSPS1_REST_PROVIDERS.megalith, supportsZeroConf: true, nodePubkey: undefined },
      b: { ...LSPS1_REST_PROVIDERS.megalith, supportsZeroConf: true, nodePubkey: "02aa" },
    };
    expect(zeroConfTrustedPubkeys(providers)).toEqual(["02aa"]);
  });
});
