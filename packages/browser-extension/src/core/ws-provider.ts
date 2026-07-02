import type { WebSocketStreamProvider, WebSocketConnection } from "@libre/listener-wallet";

// A browser/extension LDK node has no listening socket — it dials OUT through a websockify
// bridge that proxies WebSocket <-> raw TCP to the Lightning peer's :9735. This is the same
// provider the PWA (main.ts) and the PWA service-worker use, generalized to take the bridge
// URL as a parameter instead of reading a DOM input (the offscreen document has a DOM, but
// config comes from storage, not the page). Copied for the MVP; a post-MVP cleanup can hoist
// the single shared implementation into @libre/shared.
export function createWebSocketStreamProvider(getBridgeUrl: () => string | undefined): WebSocketStreamProvider {
  return {
    connect(address: string, port: number): Promise<WebSocketConnection> {
      const wsUrl = getBridgeUrl();
      if (!wsUrl) {
        return Promise.reject(new Error("No bridge URL configured — cannot connect to Lightning peer."));
      }
      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";

      const conn: WebSocketConnection = {
        send: (data: Uint8Array) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data);
        },
        close: () => socket.close(),
      };

      socket.onmessage = (event) => conn.onmessage?.(new Uint8Array(event.data as ArrayBuffer));
      socket.onclose = () => conn.onclose?.();

      return new Promise<WebSocketConnection>((resolve, reject) => {
        socket.onopen = () => resolve(conn);
        socket.onerror = () => {
          // Before open: this is a connect failure. After open: surface as a stream error.
          if (socket.readyState !== WebSocket.OPEN) {
            reject(new Error(`WebSocket bridge failed to connect to ${wsUrl} (peer ${address}:${port})`));
          } else {
            conn.onerror?.(new Error("WebSocket error"));
          }
        };
      });
    },
  };
}
