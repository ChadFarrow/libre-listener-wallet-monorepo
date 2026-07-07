import { describe, it, expect, vi } from "vitest";
import { scheduleDurableAck, pickUpdateId } from "../../durable-persist";

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
