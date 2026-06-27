// Runtime entry point for the NWC push gateway.
// The package exports the LibreNWCPushGateway class but does not start a server;
// this thin runner wires environment config and boots it. Used by Docker / Railway.
const { LibreNWCPushGateway } = require("./dist/index.js");

const gateway = new LibreNWCPushGateway({
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT) || 3001,
  dbPath: process.env.DATABASE_PATH || "push-gateway.db",
  relayUrl: process.env.DEFAULT_RELAY_URL || "wss://relay.damus.io",
});

gateway
  .start()
  .then(() => {
    console.log(`[Gateway] Push gateway active on ${process.env.HOST || "0.0.0.0"}:${process.env.PORT || 3001}`);
  })
  .catch((err) => {
    console.error("[Gateway] Boot failed:", err);
    process.exit(1);
  });

const shutdown = (signal) => {
  console.log(`[Gateway] Received ${signal}, shutting down...`);
  gateway
    .stop()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
