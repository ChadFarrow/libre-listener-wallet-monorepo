// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parsePeerAddressBook, channelPeersToRedial } from "../../index";

describe("parsePeerAddressBook", () => {
  it("returns {} for null / empty / garbage", () => {
    expect(parsePeerAddressBook(null)).toEqual({});
    expect(parsePeerAddressBook("")).toEqual({});
    expect(parsePeerAddressBook("not json")).toEqual({});
    expect(parsePeerAddressBook("[1,2,3]")).toEqual({}); // array, not a map
  });
  it("parses a valid book and drops malformed entries", () => {
    const raw = JSON.stringify({
      "02aa": { host: "1.2.3.4", port: 9735 },
      "03bb": { host: "x.onion", port: 1 },
      "04cc": { host: "nope", port: 3.5 }, // non-int port → dropped
      "05dd": { port: 9735 }, // missing host → dropped
    });
    expect(parsePeerAddressBook(raw)).toEqual({
      "02aa": { host: "1.2.3.4", port: 9735 },
      "03bb": { host: "x.onion", port: 1 },
    });
  });
});

describe("channelPeersToRedial", () => {
  const book = { "02aa": { host: "1.2.3.4", port: 9735 }, "03bb": { host: "y.io", port: 9736 } };
  it("returns address entries for channel counterparties we have an address for", () => {
    expect(channelPeersToRedial(["02aa", "03bb"], book)).toEqual([
      { pubkey: "02aa", host: "1.2.3.4", port: 9735 },
      { pubkey: "03bb", host: "y.io", port: 9736 },
    ]);
  });
  it("skips counterparties with no known address", () => {
    expect(channelPeersToRedial(["02aa", "09zz"], book)).toEqual([
      { pubkey: "02aa", host: "1.2.3.4", port: 9735 },
    ]);
  });
  it("dedupes repeated counterparties (multiple channels to one peer)", () => {
    expect(channelPeersToRedial(["02aa", "02aa"], book)).toEqual([
      { pubkey: "02aa", host: "1.2.3.4", port: 9735 },
    ]);
  });
  it("empty channels → nothing to redial", () => {
    expect(channelPeersToRedial([], book)).toEqual([]);
  });
});
