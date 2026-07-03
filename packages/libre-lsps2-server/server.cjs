// Dev entry. Regtest only: trusts lnd's self-signed TLS cert for localhost.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0";
const fs = require("fs");
const {
  LibreLsps2Server,
  LndRestClient,
  LndLspBackend,
  LndGrpcInterceptor,
  JitStore,
  loadConfig,
} = require("./dist/index.js");

const cfg = loadConfig();
if (!cfg.lndMacaroonHex) {
  console.error("Missing LND_MACAROON_HEX or LND_MACAROON_PATH — see README.");
  process.exit(1);
}
if (!fs.existsSync(cfg.lndTlsCertPath)) {
  console.error(
    `Missing lnd TLS cert at ${cfg.lndTlsCertPath}. Extract it once:\n` +
      `  docker exec libre-lnd cat /root/.lnd/tls.cert > ${cfg.lndTlsCertPath}\n` +
      `(or set LND_TLS_CERT_PATH)`
  );
  process.exit(1);
}

const lnd = new LndRestClient({ restUrl: cfg.lndRestUrl, macaroonHex: cfg.lndMacaroonHex });
const store = new JitStore();
const feeParams = {
  opening_fee_params_id: "dev",
  min_fee_msat: cfg.minFeeMsat,
  proportional_fee_ppm: cfg.proportionalFeePpm,
  min_lifetime_blocks: 2016,
  cltv_expiry_delta: 144,
  valid_until: new Date(Date.now() + 3600_000).toISOString(),
};
const backend = new LndLspBackend({ lnd, store, capacitySat: cfg.capacitySat, pushSat: cfg.pushSat, feeParams });

// The real-JIT piece: hold every forwarded HTLC and skim the one-time opening fee for a bought scid.
const interceptor = new LndGrpcInterceptor(
  { host: cfg.lndGrpcHost, tlsCert: fs.readFileSync(cfg.lndTlsCertPath), macaroonHex: cfg.lndMacaroonHex },
  { info: (m) => console.log(m), error: (m) => console.error(m) }
);
interceptor.start((req) => backend.handleIntercept(req));

const server = new LibreLsps2Server({ backend, logger: { info: (m) => console.log(m), error: (m) => console.error(m) } });
server.start(cfg.port);

const shutdown = () => {
  interceptor.stop();
  server.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
