import { describe, it, expect } from "vitest";
import { mempoolTxUrl } from "./index";

describe("mempoolTxUrl", () => {
  const TXID = "abc123def4567890abc123def4567890abc123def4567890abc123def4567890";

  it("builds a mainnet mempool.space tx link", () => {
    expect(mempoolTxUrl(TXID, "mainnet")).toBe(`https://mempool.space/tx/${TXID}`);
  });
  it("builds testnet + signet links under their paths", () => {
    expect(mempoolTxUrl(TXID, "testnet")).toBe(`https://mempool.space/testnet/tx/${TXID}`);
    expect(mempoolTxUrl(TXID, "signet")).toBe(`https://mempool.space/signet/tx/${TXID}`);
  });
  it("returns null for regtest (no public explorer) and unknown networks", () => {
    expect(mempoolTxUrl(TXID, "regtest")).toBeNull();
    expect(mempoolTxUrl(TXID, "whatever")).toBeNull();
  });
  it("returns null for an empty txid", () => {
    expect(mempoolTxUrl("", "mainnet")).toBeNull();
  });
});
