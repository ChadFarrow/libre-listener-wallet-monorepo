import { startBridge } from "./server";

const port = Number(process.env.PORT ?? 8080);
const fallbackTarget = (process.env.BRIDGE_TARGET ?? "").trim() || undefined;
const allowlist = new Set(
  (process.env.BRIDGE_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(fallbackTarget ? [fallbackTarget] : [])
);
const allowPrivate = process.env.BRIDGE_ALLOW_PRIVATE === "1";
const maxConnsPerIp = Number(process.env.MAX_CONNS_PER_IP ?? 8);

const bridge = startBridge({ port, allowlist, fallbackTarget, allowPrivate, maxConnsPerIp });
void bridge.ready.then((p) =>
  console.log(`[ws-bridge] listening :${p} allowlist={${[...allowlist].join(",")}} fallback=${fallbackTarget ?? "(none)"}`)
);
