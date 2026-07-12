import { describe, it, expect, vi, beforeEach } from "vitest";

// Disconnected so ensureDriveConnected actually runs the connect flow (the other drive test file
// hardcodes isConnected:true to skip it). A controllable `connect` lets us hold attempts in flight.
vi.mock("./core/demo-mode", () => ({ isDemoMode: () => false, demoState: {} }));

const { state, connectMock, pending } = vi.hoisted(() => {
  const state = { connected: false };
  const pending: { opts: { silent?: boolean }; resolve: () => void; reject: (e: Error) => void }[] = [];
  const connectMock = vi.fn(
    (_clientId: string, opts: { silent?: boolean }) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ opts, resolve: () => { state.connected = true; resolve(); }, reject });
      })
  );
  return { state, connectMock, pending };
});

vi.mock("./drive-backup", async (importActual) => {
  const actual = await importActual<typeof import("./drive-backup")>();
  return {
    ...actual,
    isConnected: () => state.connected,
    getConnectedEmail: () => "u@example.com",
    connect: connectMock,
  };
});

// Client id so ensureDriveConnected doesn't throw the "no client id" error.
localStorage.setItem("libre_google_client_id", "test-client-id");

import { ensureDriveConnected } from "./drive-integration";

describe("ensureDriveConnected — concurrent-attempt coalescing", () => {
  beforeEach(() => {
    state.connected = false;
    connectMock.mockClear();
    pending.length = 0;
  });

  it("coalesces two concurrent SILENT attempts into one connect", async () => {
    const a = ensureDriveConnected({ silent: true });
    const b = ensureDriveConnected({ silent: true });
    expect(connectMock).toHaveBeenCalledTimes(1);
    pending[0].resolve();
    await Promise.all([a, b]);
  });

  it("an INTERACTIVE attempt does NOT piggyback on an in-flight SILENT one (iOS: silent fails, interactive wins)", async () => {
    const silent = ensureDriveConnected({ silent: true });
    const interactive = ensureDriveConnected(); // interactive
    // Two separate attempts — the interactive one must not await the (failing) silent attempt.
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(connectMock.mock.calls[0][1].silent).toBe(true);
    expect(connectMock.mock.calls[1][1].silent).toBeFalsy(); // interactive → silent undefined/false
    // Silent rejects (blocked popup); interactive resolves — the interactive caller still succeeds.
    pending[0].reject(new Error("popup_failed_to_open"));
    pending[1].resolve();
    await expect(interactive).resolves.toBeUndefined();
    await expect(silent).rejects.toThrow(/popup/);
  });

  it("a SILENT attempt piggybacks on an in-flight INTERACTIVE one (interactive is a superset)", async () => {
    const interactive = ensureDriveConnected();
    const silent = ensureDriveConnected({ silent: true });
    expect(connectMock).toHaveBeenCalledTimes(1);
    pending[0].resolve();
    await Promise.all([interactive, silent]);
  });
});
