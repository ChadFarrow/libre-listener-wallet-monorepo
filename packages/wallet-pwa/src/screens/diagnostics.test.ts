import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initScreens } from "./index";
import { showScreen, resetToHome } from "../ui/nav";
import { installDiagTap, diagFlushNow, diagClear } from "../core/diag-tap";
import type { AppContext } from "../core/app-context";
import type { WalletController } from "../wallet-controller";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadMarkup(): void {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
}

const flushDom = () => new Promise((r) => setTimeout(r, 0));

// jsdom's Blob implementation (jsdom 24) doesn't implement `.text()`/`.arrayBuffer()` — only
// constructor/slice/size/type — so read it back via FileReader, which jsdom does implement fully.
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error as unknown);
    fr.readAsText(blob);
  });
}

function makeCtx(): AppContext {
  const controller = {
    getState: vi.fn().mockResolvedValue({ network: "mainnet", running: true, hasSeed: true, hasChannelState: true, createdNew: false, channels: 1, usableChannels: 1 }),
    getConfig: vi.fn().mockResolvedValue({ network: "mainnet" }),
    getPayments: vi.fn().mockResolvedValue([]),
    getChannelCloses: vi.fn().mockResolvedValue([]),
    listPeers: vi.fn().mockResolvedValue([]),
    getChannels: vi.fn().mockResolvedValue([]),
  } as unknown as WalletController;
  return { controller, isRunning: () => true, keepAlive: { start() {}, stop() {}, isActive: () => false } };
}

describe("diagnostics card", () => {
  beforeEach(async () => {
    loadMarkup();
    localStorage.clear();
    installDiagTap();
    await diagClear();
    resetToHome();
  });

  it("export downloads a file containing recorded lines (share unavailable → blob path)", async () => {
    console.log("[DiagTest] marker line");
    await diagFlushNow();

    const urls: Blob[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn((b: Blob) => {
        urls.push(b);
        return "blob:diag";
      }),
      revokeObjectURL: vi.fn(),
    });
    // jsdom doesn't understand the `download` attribute — a real anchor click on a `blob:` href
    // schedules an async "navigation not implemented" jsdom-internal error (a later macrotask that
    // can leak a console.error into the NEXT test's diag buffer via the tap). The download itself
    // isn't under test here (createObjectURL + blob contents are), so no-op the click.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    initScreens(makeCtx());
    await flushDom();
    showScreen("screen-dev");
    await flushDom();

    document.getElementById("diag-export")!.dispatchEvent(new Event("click"));
    await flushDom();
    await flushDom();

    expect(urls).toHaveLength(1);
    expect(await readBlobText(urls[0])).toContain("[DiagTest] marker line");
    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("clear empties the buffer and updates the readout", async () => {
    console.log("[DiagTest] to be cleared");
    await diagFlushNow();
    initScreens(makeCtx());
    await flushDom();
    showScreen("screen-dev");
    await flushDom();

    document.getElementById("diag-clear")!.dispatchEvent(new Event("click"));
    await flushDom();
    await flushDom();

    expect(document.getElementById("diag-stats")!.textContent).toMatch(/0 entries/);
  });
});
