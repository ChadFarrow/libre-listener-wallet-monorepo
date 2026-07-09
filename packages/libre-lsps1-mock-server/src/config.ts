// Env → config for the standalone dev server (server.cjs). Dev tool only; no secrets.
import type { MockLsps1Config } from "./mock-provider";

export interface MockServerConfig extends MockLsps1Config {
  port: number;
  basePath: string;
}

const num = (v: string | undefined, d: number): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadMockConfig(env: NodeJS.ProcessEnv = process.env): MockServerConfig {
  const advance = env.MOCK_ADVANCE === "timed" ? "timed" : "manual";
  return {
    port: num(env.PORT, 9098),
    basePath: env.BASE_PATH ?? "/mock-lsps1/v1",
    minChannelSat: num(env.MIN_CHANNEL_SAT, 150_000),
    maxChannelSat: num(env.MAX_CHANNEL_SAT, 16_000_000),
    maxChannelExpiryBlocks: num(env.MAX_EXPIRY_BLOCKS, 13_140),
    minRequiredChannelConfirmations: num(env.MIN_CONFS, 0),
    feeBaseSat: num(env.FEE_BASE_SAT, 2_000),
    feePpm: num(env.FEE_PPM, 4_000),
    advance,
    paidAfterMs: num(env.PAID_AFTER_MS, 4_000),
    completedAfterMs: num(env.COMPLETED_AFTER_MS, 8_000),
  };
}
