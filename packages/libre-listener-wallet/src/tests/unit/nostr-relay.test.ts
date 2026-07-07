// @vitest-environment node
//
// Docker-free validation that the in-process Nostr relay routes events between nostr-tools clients
// (and that Node's global WebSocket works with nostr-tools Relay.connect). Proves the transport the
// NWC soak relies on, so a soak failure can't be blamed on the relay.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startNostrTestRelay, NostrTestRelay } from "../integration/nostr-test-relay";
import { finalizeEvent, generateSecretKey, getPublicKey, Relay } from "nostr-tools";

let relay: NostrTestRelay;

describe("in-process Nostr relay", () => {
  beforeAll(async () => { relay = await startNostrTestRelay(); });
  afterAll(async () => { await relay.close(); });

  it("routes a published event to a subscriber matching kind + author + #e", async () => {
    const skPub = generateSecretKey();
    const pkPub = getPublicKey(skPub);
    const rSub = await Relay.connect(relay.url);
    const rPub = await Relay.connect(relay.url);

    const reqId = "e".repeat(64);
    const received = new Promise<any>((resolve) => {
      rSub.subscribe([{ kinds: [23195], authors: [pkPub], "#e": [reqId] }], { onevent: (e) => resolve(e) });
    });
    await new Promise((r) => setTimeout(r, 150)); // let the REQ register

    const ev = finalizeEvent(
      { kind: 23195, tags: [["e", reqId], ["p", "abc"]], content: "pong", created_at: Math.floor(Date.now() / 1000) },
      skPub,
    );
    await rPub.publish(ev);

    const got = await Promise.race([
      received,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout waiting for relayed event")), 5000)),
    ]);
    expect((got as any).content).toBe("pong");
    expect((got as any).pubkey).toBe(pkPub);

    await rSub.close();
    await rPub.close();
  });

  it("does not deliver an event that fails the filter (wrong #e)", async () => {
    const sk = generateSecretKey();
    const rSub = await Relay.connect(relay.url);
    const rPub = await Relay.connect(relay.url);

    let delivered = false;
    rSub.subscribe([{ kinds: [23195], "#e": ["a".repeat(64)] }], { onevent: () => { delivered = true; } });
    await new Promise((r) => setTimeout(r, 150));

    const ev = finalizeEvent(
      { kind: 23195, tags: [["e", "b".repeat(64)]], content: "nope", created_at: Math.floor(Date.now() / 1000) },
      sk,
    );
    await rPub.publish(ev);
    await new Promise((r) => setTimeout(r, 300));
    expect(delivered).toBe(false);

    await rSub.close();
    await rPub.close();
  });
});
