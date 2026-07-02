import { describe, it, expect } from "vitest";
import {
  encodeV4VTlvs,
  calculateSplits,
  type BoostRecord,
  type SplitDestination,
} from "../v4v-utils";

const decoder = new TextDecoder();

function boost(): BoostRecord {
  return {
    action: "boost",
    value_msat_total: 0,
    app_name: "libre-test",
  };
}

describe("encodeV4VTlvs", () => {
  it("always encodes the boostagram as UTF-8 JSON under key 7629169 (not hex)", () => {
    const record = boost();
    const tlvs = encodeV4VTlvs({ boostRecord: record });
    const boostTlv = tlvs.find((t) => t.key === 7629169);
    expect(boostTlv).toBeDefined();
    // bLIP-10: the value is the raw JSON string bytes, decodable back to the object.
    expect(JSON.parse(decoder.decode(boostTlv!.value))).toEqual(record);
  });

  it("adds the feedGuid as a plain string under key 7629175 only when provided", () => {
    const withGuid = encodeV4VTlvs({ boostRecord: boost(), feedGuid: "abc-guid" });
    const guidTlv = withGuid.find((t) => t.key === 7629175);
    expect(guidTlv).toBeDefined();
    expect(decoder.decode(guidTlv!.value)).toBe("abc-guid");

    const withoutGuid = encodeV4VTlvs({ boostRecord: boost() });
    expect(withoutGuid.find((t) => t.key === 7629175)).toBeUndefined();
  });

  it("includes a custom key/value pair when both are provided", () => {
    const tlvs = encodeV4VTlvs({
      boostRecord: boost(),
      customKey: 696969,
      customValue: "split-route",
    });
    const custom = tlvs.find((t) => t.key === 696969);
    expect(custom).toBeDefined();
    expect(decoder.decode(custom!.value)).toBe("split-route");
  });

  it("does not add a custom TLV when only one of key/value is provided", () => {
    const tlvs = encodeV4VTlvs({ boostRecord: boost(), customKey: 696969 });
    expect(tlvs.find((t) => t.key === 696969)).toBeUndefined();
  });

  it("encodes string and Uint8Array extraTlvs and skips non-numeric keys", () => {
    const raw = new Uint8Array([1, 2, 3]);
    const tlvs = encodeV4VTlvs({
      boostRecord: boost(),
      extraTlvs: { 100: "str-val", 200: raw, notANumber: "ignored" },
    });
    expect(decoder.decode(tlvs.find((t) => t.key === 100)!.value)).toBe("str-val");
    expect(tlvs.find((t) => t.key === 200)!.value).toEqual(raw);
    expect(tlvs.find((t) => Number.isNaN(t.key))).toBeUndefined();
  });

  it("returns records sorted by ascending key (LDK requirement)", () => {
    const tlvs = encodeV4VTlvs({
      boostRecord: boost(),
      feedGuid: "guid",
      extraTlvs: { 5: "a", 999999999: "b" },
    });
    const keys = tlvs.map((t) => t.key);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  it("deduplicates by key, keeping the last value written", () => {
    // An extraTlv that collides with the reserved feedGuid key should overwrite it.
    const tlvs = encodeV4VTlvs({
      boostRecord: boost(),
      feedGuid: "original",
      extraTlvs: { 7629175: "override" },
    });
    const guidTlvs = tlvs.filter((t) => t.key === 7629175);
    expect(guidTlvs).toHaveLength(1);
    expect(decoder.decode(guidTlvs[0].value)).toBe("override");
  });
});

describe("calculateSplits", () => {
  const template = { action: "boost" as const, app_name: "libre-test" };

  it("returns an empty array when there are no destinations", () => {
    expect(
      calculateSplits({ destinations: [], amountSats: 1000, boostRecordTemplate: template }),
    ).toEqual([]);
  });

  it("splits proportionally by share and never loses a sat (remainder to last)", () => {
    const destinations: SplitDestination[] = [
      { destinationPubkey: "a", share: 1 },
      { destinationPubkey: "b", share: 1 },
      { destinationPubkey: "c", share: 1 },
    ];
    const results = calculateSplits({ destinations, amountSats: 1000, boostRecordTemplate: template });
    // 1000 / 3 => 333, 333, and the last takes the remainder 334.
    expect(results.map((r) => r.amountSats)).toEqual([333, 333, 334]);
    expect(results.reduce((s, r) => s + r.amountSats, 0)).toBe(1000);
  });

  it("honors weighted shares", () => {
    const destinations: SplitDestination[] = [
      { destinationPubkey: "a", share: 90 },
      { destinationPubkey: "b", share: 10 },
    ];
    const results = calculateSplits({ destinations, amountSats: 1000, boostRecordTemplate: template });
    expect(results[0].amountSats).toBe(900);
    expect(results[1].amountSats).toBe(100);
  });

  it("sets value_msat_total to the full boost in msat on every recipient", () => {
    const destinations: SplitDestination[] = [{ destinationPubkey: "a", share: 1 }];
    const results = calculateSplits({ destinations, amountSats: 2500, boostRecordTemplate: template });
    expect(results[0].boostRecord.value_msat_total).toBe(2_500_000);
  });

  it("shares one boost_uuid across recipients but gives each a unique uuid", () => {
    const destinations: SplitDestination[] = [
      { destinationPubkey: "a", share: 1 },
      { destinationPubkey: "b", share: 1 },
    ];
    const results = calculateSplits({ destinations, amountSats: 1000, boostRecordTemplate: template });
    const boostUuids = new Set(results.map((r) => r.boostRecord.boost_uuid));
    const uuids = new Set(results.map((r) => r.boostRecord.uuid));
    expect(boostUuids.size).toBe(1);
    expect(uuids.size).toBe(2);
  });

  it("attaches encoded TLV records carrying the per-recipient boost", () => {
    const destinations: SplitDestination[] = [
      { destinationPubkey: "a", customKey: 5482373484, customValue: "x", share: 1 },
    ];
    const results = calculateSplits({
      destinations,
      amountSats: 1000,
      boostRecordTemplate: template,
      feedGuid: "feed-1",
    });
    const keys = results[0].tlvRecords.map((t) => t.key);
    expect(keys).toContain(7629169); // boostagram
    expect(keys).toContain(7629175); // feedGuid
    expect(keys).toContain(5482373484); // custom split-route key
  });
});
