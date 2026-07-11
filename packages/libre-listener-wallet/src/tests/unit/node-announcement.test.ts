// Pure BOLT7 node_announcement encoder: the payload we hand LDK's custom-message sender so a
// DIRECT peer (the user's own node) learns our alias. LDK's own broadcast_node_announcement
// never reaches peers that didn't request a gossip sync (lnd doesn't, from a no-gossip-features
// browser wallet) — proven by wire trace in the node-alias integration experiment.
import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  encodeNodeAnnouncement,
  NODE_ANNOUNCEMENT_MSG_TYPE,
  nextAnnouncementTimestamp,
  peersNeedingAnnouncement,
} from "../../node-announcement";

const SECRET = new Uint8Array(32).fill(7);
const PUBKEY = secp256k1.getPublicKey(SECRET, true);

function build(overrides: Partial<Parameters<typeof encodeNodeAnnouncement>[0]> = {}) {
  return encodeNodeAnnouncement({
    secretKey: SECRET,
    alias: "chad-wallet",
    rgb: new Uint8Array([0x7a, 0x5a, 0xf5]),
    timestamp: 1_700_000_000,
    ...overrides,
  });
}

describe("encodeNodeAnnouncement", () => {
  it("uses the BOLT7 wire type 257", () => {
    expect(NODE_ANNOUNCEMENT_MSG_TYPE).toBe(257);
  });

  it("encodes sig(64) + flen(2)=0 + timestamp(4) + node_id(33) + rgb(3) + alias(32) + addrlen(2)=0", () => {
    const p = build();
    expect(p.length).toBe(64 + 2 + 4 + 33 + 3 + 32 + 2);
    // empty features
    expect(p[64]).toBe(0);
    expect(p[65]).toBe(0);
    // timestamp big-endian u32
    const ts = (p[66] << 24) | (p[67] << 16) | (p[68] << 8) | p[69];
    expect(ts >>> 0).toBe(1_700_000_000);
    // node_id is our compressed pubkey
    expect(Buffer.from(p.slice(70, 103)).toString("hex")).toBe(
      Buffer.from(PUBKEY).toString("hex")
    );
    // rgb
    expect([...p.slice(103, 106)]).toEqual([0x7a, 0x5a, 0xf5]);
    // alias utf-8, zero padded to 32
    const alias = p.slice(106, 138);
    expect(new TextDecoder().decode(alias.slice(0, 11))).toBe("chad-wallet");
    expect([...alias.slice(11)].every((b) => b === 0)).toBe(true);
    // no addresses
    expect(p[138]).toBe(0);
    expect(p[139]).toBe(0);
  });

  it("signs the double-SHA256 of everything after the signature, verifiable with the node pubkey", () => {
    const p = build();
    const sig = p.slice(0, 64);
    const digest = sha256(sha256(p.slice(64)));
    expect(
      secp256k1.verify(sig, digest, PUBKEY, { prehash: false, format: "compact" })
    ).toBe(true);
  });

  it("truncates an over-long alias to 32 bytes", () => {
    const p = build({ alias: "x".repeat(64) });
    const alias = p.slice(106, 138);
    expect(new TextDecoder().decode(alias)).toBe("x".repeat(32));
    expect(p.length).toBe(140);
  });

  it("rejects a bad secret key length", () => {
    expect(() => build({ secretKey: new Uint8Array(31) })).toThrow();
  });
});

describe("nextAnnouncementTimestamp", () => {
  it("uses now when ahead of the last timestamp", () => {
    expect(nextAnnouncementTimestamp(1000, 500)).toBe(1000);
  });
  it("bumps past the last timestamp when now hasn't advanced (lnd ignores <= timestamps)", () => {
    expect(nextAnnouncementTimestamp(1000, 1000)).toBe(1001);
    expect(nextAnnouncementTimestamp(999, 1005)).toBe(1006);
  });
});

describe("peersNeedingAnnouncement", () => {
  it("announces to a never-seen peer", () => {
    const { peers, next } = peersNeedingAnnouncement(new Map(), ["aa"], new Set());
    expect(peers).toEqual(["aa"]);
    expect(next.get("aa")).toBe(false);
  });

  it("re-announces when a peer's channel becomes ready (lnd only stores the alias once the node is in its graph)", () => {
    const prev = new Map([["aa", false]]);
    const { peers, next } = peersNeedingAnnouncement(prev, ["aa"], new Set(["aa"]));
    expect(peers).toEqual(["aa"]);
    expect(next.get("aa")).toBe(true);
  });

  it("does not re-announce an unchanged peer", () => {
    const prev = new Map([["aa", true]]);
    const { peers } = peersNeedingAnnouncement(prev, ["aa"], new Set(["aa"]));
    expect(peers).toEqual([]);
  });

  it("drops state for disconnected peers so a reconnect re-announces", () => {
    const prev = new Map([
      ["aa", true],
      ["bb", false],
    ]);
    const { peers, next } = peersNeedingAnnouncement(prev, ["aa"], new Set(["aa"]));
    expect(peers).toEqual([]);
    expect(next.has("bb")).toBe(false);
  });
});
