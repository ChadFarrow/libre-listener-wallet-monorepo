// Pure request → response routing for the mock LSPS1 REST provider. Framework-agnostic (takes a
// method/path/body, returns a status + JSON body) so the Node server in server.ts is a thin adapter
// and every route is directly unit-testable without a socket. Mirrors the bLIP-51 REST binding the
// SDK's Lsps1RestClient speaks, plus a /_control plane for driving order states in a demo.
import { MockLsps1Provider, MockLspError } from "./mock-provider";

export interface RouteResult {
  status: number;
  body: unknown;
}

// `path` is the request path with the mount base already stripped (e.g. "/get_info", "/create_order",
// "/get_order", "/_control/pay"). `query` is the parsed query string. `body` is the parsed JSON body
// (undefined for GET / empty bodies).
export function routeMockLsps1(
  provider: MockLsps1Provider,
  method: string,
  path: string,
  query: URLSearchParams,
  body?: unknown
): RouteResult {
  const m = method.toUpperCase();
  const p = path.replace(/\/$/, "") || "/";

  try {
    if (m === "GET" && p === "/get_info") {
      return { status: 200, body: provider.getInfo() };
    }
    if (m === "POST" && p === "/create_order") {
      return { status: 201, body: provider.createOrder(body as never) };
    }
    if (m === "GET" && p === "/get_order") {
      const orderId = query.get("order_id");
      if (!orderId) return { status: 400, body: { error: "Missing order_id query param" } };
      return { status: 200, body: provider.getOrder(orderId) };
    }

    // --- Control plane (demo helpers; not part of LSPS1) ---
    if (m === "POST" && p === "/_control/pay") {
      return { status: 200, body: provider.markPaid(requireOrderId(query)) };
    }
    if (m === "POST" && p === "/_control/complete") {
      return { status: 200, body: provider.complete(requireOrderId(query)) };
    }
    if (m === "POST" && p === "/_control/fail") {
      return { status: 200, body: provider.fail(requireOrderId(query)) };
    }
    if (m === "POST" && p === "/_control/reset") {
      provider.reset();
      return { status: 200, body: { ok: true } };
    }
    if (m === "GET" && p === "/_control/orders") {
      return { status: 200, body: provider.listOrders() };
    }

    return { status: 404, body: { error: `No route for ${m} ${p}` } };
  } catch (e) {
    if (e instanceof MockLspError) {
      return { status: e.status, body: { error: e.message } };
    }
    throw e;
  }
}

function requireOrderId(query: URLSearchParams): string {
  const id = query.get("order_id");
  if (!id) throw new MockLspError(400, "Missing order_id query param");
  return id;
}
