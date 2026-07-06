import { describe, it, expect, afterEach } from "vitest";
import { createWebSocketStreamProvider } from "./ws-provider";

class FakeWS {
  static last?: string;
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: ArrayBuffer }) => void;
  onclose?: () => void;
  constructor(url: string) {
    FakeWS.last = url;
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {}
}

const realWS = (globalThis as any).WebSocket;
afterEach(() => {
  (globalThis as any).WebSocket = realWS;
});

describe("createWebSocketStreamProvider", () => {
  it("dials the bridge with ?target=host:port", async () => {
    (globalThis as any).WebSocket = FakeWS;
    const provider = createWebSocketStreamProvider(() => "wss://bridge.example");
    await provider.connect("64.23.162.51", 9735);
    expect(FakeWS.last).toBe("wss://bridge.example?target=64.23.162.51%3A9735");
  });

  it("rejects when no bridge URL is configured", async () => {
    (globalThis as any).WebSocket = FakeWS;
    const provider = createWebSocketStreamProvider(() => undefined);
    await expect(provider.connect("1.2.3.4", 9735)).rejects.toThrow(/bridge/i);
  });
});
