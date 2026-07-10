import { describe, it, expect, vi } from "vitest";
import { scheduleDurableAck, pickUpdateId, isUnrecoverableStatus, composeDurableFlush } from "../../durable-persist";
import { ChannelMonitorUpdateStatus } from "lightningdevkit";

// The OutdatedChannelManager fix: the channel_manager snapshot must land in the SAME durable
// batch as the monitor update, BEFORE the ack — a page kill after a monitor flush but before the
// manager's (previously lazy) persist left disk with monitor N + manager N-2, which LDK resolves
// by force-closing the channel on next load ("A ChannelManager is stale compared to the current
// ChannelMonitor!"; reproduced live 2026-07-09).
describe("composeDurableFlush", () => {
  it("without a manager persister it is the plain flush", async () => {
    const flush = vi.fn(async () => {});
    const composed = composeDurableFlush(undefined, flush);
    await composed();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("NEVER runs the manager write synchronously — the composed flush is invoked inside LDK's Persist callback, where ChannelManager.write() panics", async () => {
    const persistManager = vi.fn(async () => {});
    const composed = composeDurableFlush(persistManager, async () => {});
    const p = composed(); // invoked synchronously, as scheduleDurableAck does inside the LDK callback
    expect(persistManager).not.toHaveBeenCalled(); // must wait for the stack to unwind
    await p;
    expect(persistManager).toHaveBeenCalledTimes(1);
  });

  it("enqueues the manager write BEFORE flushing, so both land in one durable batch", async () => {
    const order: string[] = [];
    const persistManager = vi.fn(async () => {
      order.push("manager");
    });
    const flush = vi.fn(async () => {
      order.push("flush");
    });
    await composeDurableFlush(persistManager, flush)();
    expect(order).toEqual(["manager", "flush"]);
  });

  it("a failed manager write rejects WITHOUT flushing — the ack must not fire on a batch missing the manager", async () => {
    const persistManager = vi.fn(async () => {
      throw new Error("serialize failed");
    });
    const flush = vi.fn(async () => {});
    await expect(composeDurableFlush(persistManager, flush)()).rejects.toThrow("serialize failed");
    expect(flush).not.toHaveBeenCalled();
  });

  it("wired through scheduleDurableAck: manager failure leaves the channel paused (no ack)", async () => {
    const persistManager = async () => {
      throw new Error("degraded");
    };
    const ack = vi.fn();
    const onErr = vi.fn();
    scheduleDurableAck(composeDurableFlush(persistManager, async () => {}), ack, onErr);
    await new Promise((r) => setTimeout(r, 0));
    expect(ack).not.toHaveBeenCalled();
    expect(onErr).toHaveBeenCalledTimes(1);
  });
});

describe("scheduleDurableAck", () => {
  it("calls ack only after flush resolves", async () => {
    let release!: () => void;
    const flush = () => new Promise<void>((r) => (release = r));
    const ack = vi.fn();
    const onErr = vi.fn();
    scheduleDurableAck(flush, ack, onErr);
    await Promise.resolve();
    expect(ack).not.toHaveBeenCalled(); // durable commit not yet landed
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(onErr).not.toHaveBeenCalled();
  });

  it("calls onFlushError and NOT ack when flush rejects (leaves LDK paused)", async () => {
    const flush = () => Promise.reject(new Error("degraded"));
    const ack = vi.fn();
    const onErr = vi.fn();
    scheduleDurableAck(flush, ack, onErr);
    await new Promise((r) => setTimeout(r, 0));
    expect(ack).not.toHaveBeenCalled();
    expect(onErr).toHaveBeenCalledTimes(1);
  });

  it("routes a synchronous throw in ack to onError (no unobserved rejection)", async () => {
    const flush = () => Promise.resolve();
    const ack = () => {
      throw new Error("boom");
    };
    const onErr = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    scheduleDurableAck(flush, ack, onErr);
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", unhandled);
    expect(onErr).toHaveBeenCalledTimes(1);
    expect((onErr.mock.calls[0][0] as Error).message).toBe("boom");
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("pickUpdateId", () => {
  it("reads the update id from a present wrapper (ptr !== 0)", () => {
    const update = { ptr: 1n, get_update_id: () => 5n };
    expect(pickUpdateId(update as any, 9n)).toBe(5n);
  });

  it("falls back to latest for a None-wrapper (ptr === 0n) — NOT the bogus 0n id", () => {
    const noneWrapper = { ptr: 0n, get_update_id: () => 0n };
    expect(pickUpdateId(noneWrapper as any, 9n)).toBe(9n);
  });

  it("falls back to latest for a JS null update", () => {
    expect(pickUpdateId(null, 9n)).toBe(9n);
  });
});

describe("isUnrecoverableStatus", () => {
  it("is true only for UnrecoverableError (so the wrapper can propagate it, not mask it as InProgress)", () => {
    expect(isUnrecoverableStatus(ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_UnrecoverableError)).toBe(true);
    expect(isUnrecoverableStatus(ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_Completed)).toBe(false);
    expect(isUnrecoverableStatus(ChannelMonitorUpdateStatus.LDKChannelMonitorUpdateStatus_InProgress)).toBe(false);
    expect(isUnrecoverableStatus(null)).toBe(false);
    expect(isUnrecoverableStatus(undefined)).toBe(false);
  });
});
