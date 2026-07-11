import { describe, it, expect } from "vitest";
import { currentOnboardingStep } from "./onboarding-flow";

describe("currentOnboardingStep — the hard gate", () => {
  it("no wallet → welcome", () => {
    expect(
      currentOnboardingStep({ hasWallet: false, backedUp: false, driveConfigured: false, channels: 0, everHadChannel: false }),
    ).toBe("welcome");
  });

  it("wallet created but seed not confirmed saved → seed (resume after app kill)", () => {
    expect(
      currentOnboardingStep({ hasWallet: true, backedUp: false, driveConfigured: false, channels: 0, everHadChannel: false }),
    ).toBe("seed");
  });

  it("seed saved but Drive not configured → drive", () => {
    expect(
      currentOnboardingStep({ hasWallet: true, backedUp: true, driveConfigured: false, channels: 0, everHadChannel: false }),
    ).toBe("drive");
  });

  it("Drive configured but no channel → channel", () => {
    expect(
      currentOnboardingStep({ hasWallet: true, backedUp: true, driveConfigured: true, channels: 0, everHadChannel: false }),
    ).toBe("channel");
  });

  it("everything present → done (home may render)", () => {
    expect(
      currentOnboardingStep({ hasWallet: true, backedUp: true, driveConfigured: true, channels: 1, everHadChannel: false }),
    ).toBe("done");
  });

  it("a pending (not yet usable) channel still counts as done — the pill handles 'opening'", () => {
    expect(
      currentOnboardingStep({ hasWallet: true, backedUp: true, driveConfigured: true, channels: 1, everHadChannel: false }),
    ).toBe("done");
  });

  it("a wallet that HAD a channel (close on record) never re-enters the channel step", () => {
    expect(
      currentOnboardingStep({ hasWallet: true, backedUp: true, driveConfigured: true, channels: 0, everHadChannel: true })
    ).toBe("done");
  });

  it("a brand-new wallet with no channel still gets the channel step", () => {
    expect(
      currentOnboardingStep({ hasWallet: true, backedUp: true, driveConfigured: true, channels: 0, everHadChannel: false })
    ).toBe("channel");
  });
});
