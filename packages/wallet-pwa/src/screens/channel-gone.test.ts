import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initScreens } from "./index";
import { showScreen, resetToHome } from "../ui/nav";
import type { AppContext } from "../core/app-context";
import type { WalletControllerApi } from "@libre/wallet-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMarkup(): void {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const CLOSED_STATE = {
  network: "mainnet",
  running: true,
  hasSeed: true,
  hasChannelState: true,
  createdNew: false,
  channels: 0,
  usableChannels: 0,
  peers: 1,
  closes: { count: 1, last: { channelId: "ab".repeat(32), reason: "counterparty-force-closed", closedAt: Date.now() - 3_600_000 } },
  sweep: { needsAddress: false, pendingCount: 1, pendingSat: 93_813 },
};

function makeCtx(state: unknown): AppContext {
  const controller = {
    getState: vi.fn().mockResolvedValue(state),
    getPayments: vi.fn().mockResolvedValue([]),
    getChannelCloses: vi.fn().mockResolvedValue([]),
    listPeers: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ spendableSat: 0, receivableSat: 0 }),
    getChannels: vi.fn().mockResolvedValue([]),
  } as unknown as WalletControllerApi;
  return { controller, isRunning: () => true, keepAlive: { start() {}, stop() {}, unlock() {}, isActive: () => false, needsActivation: () => false } };
}

describe("channel-gone UX", () => {
  beforeEach(() => {
    loadMarkup();
    localStorage.clear();
  });

  it("channels screen shows the close-aware empty state, not first-run copy", async () => {
    initScreens(makeCtx(CLOSED_STATE));
    await flush();
    resetToHome(); // ui/nav's screen stack is a module singleton — reset it so this test's push isn't a no-op against a previous test's leftover "current" screen.
    showScreen("screen-channels");
    await flush();
    const list = document.getElementById("channels-list")!;
    expect(list.textContent).toMatch(/channel closed/i);
    expect(list.textContent).toMatch(/recovering/i);
    expect(list.textContent).not.toMatch(/no channels yet/i);
  });

  it("channels screen keeps first-run copy for a wallet that never had one", async () => {
    initScreens(makeCtx({ ...CLOSED_STATE, hasChannelState: false, closes: { count: 0 }, sweep: { needsAddress: false, pendingCount: 0, pendingSat: 0 } }));
    await flush();
    resetToHome();
    showScreen("screen-channels");
    await flush();
    expect(document.getElementById("channels-list")!.textContent).toMatch(/no channels yet/i);
  });

  it("get-channel screen reads 'Get a new channel' after a close", async () => {
    initScreens(makeCtx(CLOSED_STATE));
    await flush();
    resetToHome();
    showScreen("screen-get-channel");
    await flush();
    expect(document.getElementById("gc-title")!.textContent).toBe("Get a new channel");
  });
});
