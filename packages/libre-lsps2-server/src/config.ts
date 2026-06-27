import * as fs from "fs";

export interface Lsps2ServerConfig {
  port: number;
  lndRestUrl: string;
  lndMacaroonHex: string;
  bitcoindRpcUrl: string;
  bitcoindUser: string;
  bitcoindPass: string;
  mineAddress: string;
  capacitySat: number;
  pushSat: number;
  confirmBlocks: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Lsps2ServerConfig {
  // Macaroon: hex directly, or read+hex-encode a file path.
  let macaroonHex = env.LND_MACAROON_HEX ?? "";
  if (!macaroonHex && env.LND_MACAROON_PATH) {
    macaroonHex = fs.readFileSync(env.LND_MACAROON_PATH).toString("hex");
  }
  return {
    port: Number(env.PORT ?? 9099),
    lndRestUrl: env.LND_REST_URL ?? "https://127.0.0.1:8088",
    lndMacaroonHex: macaroonHex,
    bitcoindRpcUrl: env.BITCOIND_RPC_URL ?? "http://127.0.0.1:18443",
    bitcoindUser: env.BITCOIND_RPC_USER ?? "libre",
    bitcoindPass: env.BITCOIND_RPC_PASS ?? "listener",
    // Fixed regtest address for mining confirmation blocks (avoids getnewaddress,
    // which needs a loaded bitcoind wallet).
    mineAddress: env.MINE_ADDRESS ?? "bcrt1qwqp2ru0sx58gpv4fmleuf02wcmu8rs5w93ld6u",
    capacitySat: Number(env.CHANNEL_CAPACITY_SAT ?? 1_000_000),
    pushSat: Number(env.PUSH_SAT ?? 200_000),
    confirmBlocks: Number(env.CONFIRM_BLOCKS ?? 6),
  };
}
