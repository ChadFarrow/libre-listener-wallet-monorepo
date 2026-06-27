// Dev entry. Regtest only: trusts lnd's self-signed TLS cert for localhost.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0";
const { LibreLsps2Server, LndRestClient, BitcoindClient, LndLspBackend, loadConfig } = require("./dist/index.js");

const cfg = loadConfig();
if (!cfg.lndMacaroonHex) {
  console.error("Missing LND_MACAROON_HEX or LND_MACAROON_PATH — see README.");
  process.exit(1);
}
const lnd = new LndRestClient({ restUrl: cfg.lndRestUrl, macaroonHex: cfg.lndMacaroonHex });
const bitcoind = new BitcoindClient({ rpcUrl: cfg.bitcoindRpcUrl, user: cfg.bitcoindUser, pass: cfg.bitcoindPass, mineAddress: cfg.mineAddress });
const backend = new LndLspBackend({ lnd, bitcoind, capacitySat: cfg.capacitySat, pushSat: cfg.pushSat, confirmBlocks: cfg.confirmBlocks });
const server = new LibreLsps2Server({ backend, logger: { info: (m) => console.log(m), error: (m) => console.error(m) } });
server.start(cfg.port);
