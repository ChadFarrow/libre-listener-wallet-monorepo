import { describe, it, expect, vi } from "vitest";
import { scheduleDurableAck } from "../../durable-persist";

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
});
