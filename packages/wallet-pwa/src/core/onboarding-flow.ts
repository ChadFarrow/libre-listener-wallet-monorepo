// The onboarding hard gate: home renders ONLY when the flow is complete. On every boot the
// app resumes at the first incomplete step (so an app kill mid-flow can't skip anything).
// Same inputs as computeChecklist — this is the full-screen-flow projection of that logic.

export type OnboardingStep = "welcome" | "seed" | "drive" | "channel" | "done";

export interface OnboardingInputs {
  hasWallet: boolean;
  backedUp: boolean; // per-network seed-backed-up marker (core/onboarding.ts)
  driveConfigured: boolean; // remembered Drive account — the mandatory-backup gate signal
  channels: number; // total channels incl. pending — the pill handles "opening"
  everHadChannel: boolean; // close record or prior channel state — a RETURNING user, not a first-run
}

export function currentOnboardingStep(i: OnboardingInputs): OnboardingStep {
  if (!i.hasWallet) return "welcome";
  if (!i.backedUp) return "seed";
  if (!i.driveConfigured) return "drive";
  // Only a wallet that never had a channel gets the first-channel step. After a close the
  // status pill owns the "get a new one" nudge — the full-screen gate must not hijack home.
  if (i.channels === 0 && !i.everHadChannel) return "channel";
  return "done";
}
