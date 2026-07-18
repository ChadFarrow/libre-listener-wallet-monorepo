import { describe, it, expect, vi } from "vitest";
import { ConfirmationTarget } from "lightningdevkit";
import { EsploraSyncClient } from "../../esplora-client";

// The feerate a peer proposes when opening a channel is validated by LDK against
// the MinAllowed*RemoteFee confirmation targets. Those must be LENIENT (a low,
// economy/background rate) so we accept any economically-valid feerate a well-
// behaved counterparty proposes — otherwise an inbound channel open is rejected
// with "Peer's feerate much too low" whenever the opener's estimate is even
// slightly below our current market (6-block) estimate. Regression: a channel
// open from lnd/ThunderHub proposing 284 sat/kw was rejected against a 369 floor
// because the MinAllowed* targets fell through to the 6-block market rate.
describe("EsploraSyncClient.getFeeRate — remote-fee acceptance floor", () => {
  async function clientWithEstimates(estimates: Record<string, number>) {
    const client = new EsploraSyncClient("https://mock-esplora.api");
    vi.spyOn(client, "fetchFeeEstimates").mockResolvedValue(estimates);
    await client.updateFeeEstimates();
    return client;
  }

  // sat/vB by confirmation-block target; getFeeRate returns sat/kw = max(253, rate*250)
  const estimates = { "1": 5.0, "6": 2.0, "144": 1.5, "1008": 1.0 };

  it("uses a lenient economy rate for the MinAllowed non-anchor remote-fee floor", async () => {
    const client = await clientWithEstimates(estimates);

    // 6-block market rate → 2.0 * 250 = 500 sat/kw (what the bug used as the floor)
    expect(client.getFeeRate(ConfirmationTarget.LDKConfirmationTarget_NonAnchorChannelFee)).toBe(
      500,
    );

    // Acceptance floor must be lenient (1008-block economy → 250, clamped to 253),
    // strictly below the regular channel feerate.
    const floor = client.getFeeRate(
      ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee,
    );
    expect(floor).toBe(253);
    expect(floor).toBeLessThan(
      client.getFeeRate(ConfirmationTarget.LDKConfirmationTarget_NonAnchorChannelFee),
    );
  });

  it("accepts the lnd-proposed 284 sat/kw that the bug rejected", async () => {
    const client = await clientWithEstimates(estimates);
    const floor = client.getFeeRate(
      ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee,
    );
    expect(284).toBeGreaterThanOrEqual(floor);
  });

  it("keeps the anchor remote-fee floor at the relay minimum", async () => {
    const client = await clientWithEstimates(estimates);
    expect(
      client.getFeeRate(ConfirmationTarget.LDKConfirmationTarget_MinAllowedAnchorChannelRemoteFee),
    ).toBe(253);
  });

  it("never drops below the 253 sat/kw relay floor even with a near-zero estimate", async () => {
    const client = await clientWithEstimates({ "6": 2.0, "1008": 0.1 });
    expect(
      client.getFeeRate(
        ConfirmationTarget.LDKConfirmationTarget_MinAllowedNonAnchorChannelRemoteFee,
      ),
    ).toBe(253);
  });
});
