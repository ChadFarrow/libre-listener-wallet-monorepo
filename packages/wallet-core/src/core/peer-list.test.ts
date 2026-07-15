import { describe, it, expect } from "vitest";
import { buildPeerRows } from "./peer-list";

const PK_A = "aa".repeat(33).slice(0, 66);
const PK_B = "bb".repeat(33).slice(0, 66);
const PK_C = "cc".repeat(33).slice(0, 66);

describe("buildPeerRows", () => {
  it("merges connected peers with the address book", () => {
    const rows = buildPeerRows({
      connected: [PK_A],
      book: { [PK_A]: { host: "1.2.3.4", port: 9735 } },
      channelPeers: [],
    });
    expect(rows).toEqual([{ pubkey: PK_A, address: "1.2.3.4:9735", connected: true, hasChannel: false }]);
  });

  it("includes book-only peers as disconnected (node-stopped view)", () => {
    const rows = buildPeerRows({
      connected: [],
      book: { [PK_B]: { host: "example.onion", port: 9735 } },
      channelPeers: [],
    });
    expect(rows).toEqual([{ pubkey: PK_B, address: "example.onion:9735", connected: false, hasChannel: false }]);
  });

  it("flags channel counterparties and leaves unknown addresses undefined", () => {
    const rows = buildPeerRows({
      connected: [PK_C],
      book: {},
      channelPeers: [PK_C],
    });
    expect(rows).toEqual([{ pubkey: PK_C, address: undefined, connected: true, hasChannel: true }]);
  });

  it("orders channel peers first, then connected, then the rest — with no duplicates", () => {
    const rows = buildPeerRows({
      connected: [PK_A, PK_B],
      book: { [PK_B]: { host: "b.example", port: 9735 }, [PK_C]: { host: "c.example", port: 9736 } },
      channelPeers: [PK_B],
    });
    expect(rows.map((r) => r.pubkey)).toEqual([PK_B, PK_A, PK_C]);
    expect(new Set(rows.map((r) => r.pubkey)).size).toBe(rows.length);
  });
});
