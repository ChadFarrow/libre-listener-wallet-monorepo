import { describe, it, expect, afterEach } from "vitest";
import { LibreListenerWallet, SecureStorageProvider, WebSocketStreamProvider } from "../../index";
import { serializeAndEncryptV1 } from "../../state-backup";
import { encodeKeyValue, type VssKeyValue } from "../../vss-protobuf";

// The read-path re-hydration (maybeRestoreStateFromVss) is exercised directly on a stopped wallet,
// with globalThis.fetch stubbed to serve a real GetObjectResponse. No LDK start / WASM needed —
// it's pure storage + crypto + the VSS transport.

const SEED = "aa".repeat(32);

function memStorage(initial: Record<string, string> = {}): { storage: SecureStorageProvider; mem: Record<string, string> } {
  const mem: Record<string, string> = { ...initial };
  return {
    mem,
    storage: {
      getItem: async (k) => (k in mem ? mem[k] : null),
      setItem: async (k, v) => { mem[k] = v; },
      removeItem: async (k) => { delete mem[k]; },
    },
  };
}

const noopSocket: WebSocketStreamProvider = { connect: async () => { throw new Error("unused"); } };

function makeWallet(mem: Record<string, string>, storage: SecureStorageProvider, network = "regtest") {
  return new LibreListenerWallet({
    config: { network: network as any, esploraUrl: "http://127.0.0.1:3002", vssUrl: "https://vss.test/vss" },
    storage,
    socketProvider: noopSocket,
  });
}

// Build the bytes a real vss-server returns for GetObject: a GetObjectResponse (field 2 = KeyValue).
// The length prefix must be a proper varint — the envelope KeyValue is >127 bytes.
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}
function getObjectResponseBytes(kv: VssKeyValue): Uint8Array {
  const inner = encodeKeyValue(kv);
  return Uint8Array.from([0x12, ...varint(inner.length), ...inner]);
}

async function makeEnvelope(network: string, stateVersion = 5): Promise<string> {
  const payload = {
    version: 1 as const,
    network: network as any,
    exportedAt: 0,
    entries: {
      ldk_seed: SEED,
      channel_manager: "deadbeef",
      ldk_keys_index: "[]",
      state_version: String(stateVersion),
    },
  };
  return serializeAndEncryptV1(payload, SEED);
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(response: Response | (() => Response)) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return typeof response === "function" ? response() : response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("maybeRestoreStateFromVss", () => {
  it("re-hydrates channel state from VSS when the seed exists but no channel_manager", async () => {
    const { mem, storage } = memStorage({ ldk_seed: SEED });
    const envelope = await makeEnvelope("regtest");
    const respBytes = getObjectResponseBytes({ key: "state_backup", version: 1, value: new TextEncoder().encode(envelope) });
    const calls = stubFetch(new Response(respBytes, { status: 200 }));

    const wallet = makeWallet(mem, storage);
    const restored = await wallet["maybeRestoreStateFromVss"](SEED);

    expect(restored).toBe(true);
    expect(mem.channel_manager).toBe("deadbeef");
    expect(mem.state_version).toBe("5");
    expect(calls[0]).toBe("https://vss.test/vss/getObject");
  });

  it("PRESERVES a retained high-water mark across re-hydrate (so a stale VSS replica still trips the regression guard)", async () => {
    // Local storage was partially wiped: channel_manager gone, but a high-water mark proving this
    // wallet durably reached update N survives. importState clears the mark; the VSS re-hydrate must
    // put it back so the downstream Layer-A guard can HALT on a stale (behind-N) replica.
    const retained = JSON.stringify({ "abcd": "9" });
    const { mem, storage } = memStorage({ ldk_seed: SEED, monitor_update_highwater: retained });
    const envelope = await makeEnvelope("regtest");
    const respBytes = getObjectResponseBytes({ key: "state_backup", version: 1, value: new TextEncoder().encode(envelope) });
    stubFetch(new Response(respBytes, { status: 200 }));

    const wallet = makeWallet(mem, storage);
    const restored = await wallet["maybeRestoreStateFromVss"](SEED);

    expect(restored).toBe(true);
    // The tripwire is preserved (NOT blanked by importState) — the guard survives an auto-rehydrate.
    expect(mem.monitor_update_highwater).toBe(retained);
  });

  it("does NOT restore (and does not fetch) when local channel_manager already exists", async () => {
    // Never copy VSS state over EXISTING local channel state — LDK can't cleanly reconstruct the
    // channel that way (cross-device active-handoff limitation). Only empty-local re-hydrates.
    const { mem, storage } = memStorage({ ldk_seed: SEED, channel_manager: "cafe" });
    const calls = stubFetch(new Response(new Uint8Array(0), { status: 200 }));

    const wallet = makeWallet(mem, storage);
    const restored = await wallet["maybeRestoreStateFromVss"](SEED);

    expect(restored).toBe(false);
    expect(mem.channel_manager).toBe("cafe"); // untouched
    expect(calls).toHaveLength(0); // short-circuits before fetching
  });

  it("returns false when VSS has nothing (404 / NoSuchKey)", async () => {
    const { mem, storage } = memStorage({ ldk_seed: SEED });
    stubFetch(new Response(new Uint8Array(0), { status: 404 }));

    const wallet = makeWallet(mem, storage);
    expect(await wallet["maybeRestoreStateFromVss"](SEED)).toBe(false);
    expect(mem.channel_manager).toBeUndefined();
  });

  it("refuses a wrong-network envelope (does not write channel state)", async () => {
    const { mem, storage } = memStorage({ ldk_seed: SEED });
    const envelope = await makeEnvelope("mainnet"); // wallet is regtest
    const respBytes = getObjectResponseBytes({ key: "state_backup", version: 1, value: new TextEncoder().encode(envelope) });
    stubFetch(new Response(respBytes, { status: 200 }));

    const wallet = makeWallet(mem, storage);
    const restored = await wallet["maybeRestoreStateFromVss"](SEED);

    expect(restored).toBe(false);
    expect(mem.channel_manager).toBeUndefined();
  });

  it("swallows a VSS transport error (best-effort) and returns false", async () => {
    const { mem, storage } = memStorage({ ldk_seed: SEED });
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;

    const wallet = makeWallet(mem, storage);
    expect(await wallet["maybeRestoreStateFromVss"](SEED)).toBe(false);
    expect(mem.channel_manager).toBeUndefined();
  });
});
