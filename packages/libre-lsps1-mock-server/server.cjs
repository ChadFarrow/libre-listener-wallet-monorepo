// Dev entry: a standalone mock LSPS1-REST provider for building/testing the "get a channel from an
// LSP" flow (PWA / extension) offline — no real LSP, no money, no docker. Point the app's LSPS1 REST
// base URL at the printed base and click through create-order → poll → completed.
//
//   pnpm --filter @libre/lsps1-mock-server build && pnpm --filter @libre/lsps1-mock-server start
//   # or: node packages/libre-lsps1-mock-server/server.cjs
//
// Env: PORT (9098), BASE_PATH (/mock-lsps1/v1), MIN/MAX_CHANNEL_SAT, MIN_CONFS (0=0-conf-capable),
//      FEE_BASE_SAT, FEE_PPM, MOCK_ADVANCE=manual|timed, PAID_AFTER_MS, COMPLETED_AFTER_MS.
const { startMockLsps1Server, MockLsps1Provider, loadMockConfig } = require("./dist/index.js");

const cfg = loadMockConfig();
const provider = new MockLsps1Provider(cfg);

startMockLsps1Server({ port: cfg.port, basePath: cfg.basePath, provider })
  .then((s) => {
    console.log(`\nMock LSPS1 provider ready.`);
    console.log(`  LSPS1 REST base URL (paste into the app):  ${s.baseUrl}`);
    console.log(`  Advance mode: ${cfg.advance}` + (cfg.advance === "timed" ? ` (paid@${cfg.paidAfterMs}ms, completed@${cfg.completedAfterMs}ms)` : ""));
    console.log(`  Channel bounds: ${cfg.minChannelSat}–${cfg.maxChannelSat} sat, ${cfg.minRequiredChannelConfirmations}-conf`);
    console.log(`\n  Drive an order manually (manual mode):`);
    console.log(`    curl -X POST "${s.baseUrl}/_control/pay?order_id=mock-order-1"`);
    console.log(`    curl -X POST "${s.baseUrl}/_control/complete?order_id=mock-order-1"`);
    console.log(`    curl -X POST "${s.baseUrl}/_control/fail?order_id=mock-order-1"`);
    console.log(`    curl      "${s.baseUrl}/_control/orders"\n`);

    const shutdown = () => s.close().finally(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((e) => {
    console.error("Failed to start mock LSPS1 server:", e);
    process.exit(1);
  });
