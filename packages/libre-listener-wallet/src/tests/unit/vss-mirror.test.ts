import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VssMirror, deriveVssStoreId, VSS_STATE_BACKUP_KEY } from "../../vss-mirror";
import type { VssKeyValue } from "../../vss-protobuf";

function stubClient() {
  const puts: VssKeyValue[][] = [];
  let reject: Error | null = null;
  return {
    puts,
    failWith(e: Error) {
      reject = e;
    },
    putObjects: vi.fn(async (items: VssKeyValue[]) => {
      if (reject) throw reject;
      puts.push(items);
    }),
  };
}

describe("deriveVssStoreId", () => {
  it("is stable for a seed and different across seeds, and never contains the raw seed", async () => {
    const seed = "aa".repeat(32);
    const id1 = await deriveVssStoreId(seed);
    const id2 = await deriveVssStoreId(seed);
    const other = await deriveVssStoreId("bb".repeat(32));
    expect(id1).toBe(id2);
    expect(id1).not.toBe(other);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
    expect(id1).not.toContain(seed);
  });
});

describe("VssMirror", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces a burst of schedule() calls into a single blind-write upload", async () => {
    const client = stubClient();
    const mirror = new VssMirror(client, async () => "ENVELOPE", { debounceMs: 5000 });

    mirror.schedule();
    mirror.schedule();
    mirror.schedule();
    await vi.advanceTimersByTimeAsync(5000);

    expect(client.putObjects).toHaveBeenCalledTimes(1);
    expect(client.puts).toHaveLength(1);
    const item = client.puts[0][0];
    expect(item.key).toBe(VSS_STATE_BACKUP_KEY);
    expect(item.version).toBe(-1); // blind write
    expect(new TextDecoder().decode(item.value)).toBe("ENVELOPE");
  });

  it("does not upload until the debounce window elapses", async () => {
    const client = stubClient();
    const mirror = new VssMirror(client, async () => "x", { debounceMs: 5000 });
    mirror.schedule();
    await vi.advanceTimersByTimeAsync(4999);
    expect(client.putObjects).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.putObjects).toHaveBeenCalledTimes(1);
  });

  it("swallows a VSS failure (best-effort) and warns", async () => {
    const client = stubClient();
    client.failWith(new Error("vss down"));
    const warn = vi.fn();
    const mirror = new VssMirror(client, async () => "x", { debounceMs: 10, logger: { warn } });
    mirror.schedule();
    await expect(vi.advanceTimersByTimeAsync(10)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("vss down"));
  });

  it("swallows an export failure without uploading", async () => {
    const client = stubClient();
    const mirror = new VssMirror(client, async () => {
      throw new Error("export boom");
    }, { debounceMs: 10 });
    mirror.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(client.putObjects).not.toHaveBeenCalled();
  });

  it("stop() cancels a pending mirror", async () => {
    const client = stubClient();
    const mirror = new VssMirror(client, async () => "x", { debounceMs: 5000 });
    mirror.schedule();
    mirror.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.putObjects).not.toHaveBeenCalled();
  });

  it("flush() uploads immediately without waiting for the debounce", async () => {
    const client = stubClient();
    const mirror = new VssMirror(client, async () => "now", { debounceMs: 5000 });
    void mirror.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.putObjects).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(client.puts[0][0].value)).toBe("now");
  });

  it("re-runs after an in-flight upload if more changes arrived meanwhile", async () => {
    const client = stubClient();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const exportEnvelope = vi.fn(async () => {
      calls++;
      if (calls === 1) await gate; // hold the first upload open
      return `v${calls}`;
    });
    const mirror = new VssMirror(client, exportEnvelope, { debounceMs: 10 });

    mirror.schedule();
    await vi.advanceTimersByTimeAsync(10); // first run starts, awaits gate
    mirror.schedule(); // arrives while first is in-flight
    await vi.advanceTimersByTimeAsync(10); // its timer fires -> run() sees inFlight, marks pending
    release();
    await vi.advanceTimersByTimeAsync(20); // first finishes -> schedules the pending re-run

    expect(exportEnvelope).toHaveBeenCalledTimes(2);
    expect(client.puts.map((p) => new TextDecoder().decode(p[0].value))).toEqual(["v1", "v2"]);
  });
});
