import { describe, it, expect } from "vitest";
import {
  parseLightningAddress,
  lnurlpUrl,
  parseLnurlPayResponse,
  buildLnurlPayCallbackUrl,
  parseLnurlPayCallbackResponse,
} from "./lnurl-pay";

describe("parseLightningAddress", () => {
  it("parses name@domain", () => {
    expect(parseLightningAddress("artist@v4vmusic.com")).toEqual({ name: "artist", domain: "v4vmusic.com" });
  });

  it("lowercases and trims", () => {
    expect(parseLightningAddress("  Artist@V4VMusic.COM ")).toEqual({ name: "artist", domain: "v4vmusic.com" });
  });

  it("accepts loopback host:port domains (regtest/dev)", () => {
    expect(parseLightningAddress("artist@127.0.0.1:9321")).toEqual({ name: "artist", domain: "127.0.0.1:9321" });
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["", "nodomain", "@x.com", "a@", "a@@b.com", "a b@x.com", "a@x com"]) {
      expect(() => parseLightningAddress(bad), bad).toThrow();
    }
  });
});

describe("lnurlpUrl", () => {
  it("builds the LUD-16 well-known URL over https", () => {
    expect(lnurlpUrl({ name: "artist", domain: "v4vmusic.com" })).toBe(
      "https://v4vmusic.com/.well-known/lnurlp/artist"
    );
  });

  it("uses http for loopback domains so regtest/dev servers work", () => {
    expect(lnurlpUrl({ name: "artist", domain: "127.0.0.1:9321" })).toBe(
      "http://127.0.0.1:9321/.well-known/lnurlp/artist"
    );
    expect(lnurlpUrl({ name: "a", domain: "localhost:8080" })).toBe(
      "http://localhost:8080/.well-known/lnurlp/a"
    );
  });
});

const okParams = {
  tag: "payRequest",
  callback: "https://v4vmusic.com/lnurlp/artist/cb",
  minSendable: 1000,
  maxSendable: 100_000_000,
  metadata: '[["text/plain","pay artist"]]',
};

describe("parseLnurlPayResponse", () => {
  it("accepts a valid LUD-06 payRequest", () => {
    const p = parseLnurlPayResponse(okParams);
    expect(p.callback).toBe(okParams.callback);
    expect(p.minSendableMsat).toBe(1000);
    expect(p.maxSendableMsat).toBe(100_000_000);
    expect(p.metadata).toBe(okParams.metadata);
  });

  it("carries commentAllowed through when present (LUD-12)", () => {
    expect(parseLnurlPayResponse({ ...okParams, commentAllowed: 120 }).commentAllowed).toBe(120);
  });

  it("throws the server's reason on an LNURL error response", () => {
    expect(() => parseLnurlPayResponse({ status: "ERROR", reason: "no such user" })).toThrow(/no such user/);
  });

  it("rejects wrong tag, missing fields, non-http callback, and inverted bounds", () => {
    expect(() => parseLnurlPayResponse({ ...okParams, tag: "withdrawRequest" })).toThrow();
    expect(() => parseLnurlPayResponse({ ...okParams, callback: undefined })).toThrow();
    expect(() => parseLnurlPayResponse({ ...okParams, callback: "ftp://x.com/cb" })).toThrow();
    expect(() => parseLnurlPayResponse({ ...okParams, minSendable: 5000, maxSendable: 1000 })).toThrow();
    expect(() => parseLnurlPayResponse(null)).toThrow();
  });
});

describe("buildLnurlPayCallbackUrl", () => {
  const params = parseLnurlPayResponse(okParams);

  it("appends the amount in msat", () => {
    expect(buildLnurlPayCallbackUrl(params, 21_000)).toBe(`${okParams.callback}?amount=21000`);
  });

  it("appends with & when the callback already has a query", () => {
    const p = parseLnurlPayResponse({ ...okParams, callback: `${okParams.callback}?k=v` });
    expect(buildLnurlPayCallbackUrl(p, 21_000)).toBe(`${okParams.callback}?k=v&amount=21000`);
  });

  it("rejects amounts outside min/max or non-integer", () => {
    expect(() => buildLnurlPayCallbackUrl(params, 999)).toThrow(/minimum/i);
    expect(() => buildLnurlPayCallbackUrl(params, 100_000_001)).toThrow(/maximum/i);
    expect(() => buildLnurlPayCallbackUrl(params, 1000.5)).toThrow();
  });

  it("includes a comment only when the server allows one that long (LUD-12)", () => {
    const p = parseLnurlPayResponse({ ...okParams, commentAllowed: 10 });
    expect(buildLnurlPayCallbackUrl(p, 21_000, "go pod go")).toBe(
      `${okParams.callback}?amount=21000&comment=go%20pod%20go`
    );
    // Too long for the server's limit → dropped, not truncated silently into a different message.
    expect(buildLnurlPayCallbackUrl(p, 21_000, "a comment longer than ten")).toBe(
      `${okParams.callback}?amount=21000`
    );
    // Server doesn't advertise comments → never sent.
    expect(buildLnurlPayCallbackUrl(params, 21_000, "hi")).toBe(`${okParams.callback}?amount=21000`);
  });
});

describe("parseLnurlPayCallbackResponse", () => {
  it("returns the invoice", () => {
    expect(parseLnurlPayCallbackResponse({ pr: "lnbc1..." })).toEqual({ pr: "lnbc1..." });
  });

  it("throws the server's reason on error, and on missing pr", () => {
    expect(() => parseLnurlPayCallbackResponse({ status: "ERROR", reason: "out of range" })).toThrow(/out of range/);
    expect(() => parseLnurlPayCallbackResponse({})).toThrow();
    expect(() => parseLnurlPayCallbackResponse(null)).toThrow();
  });
});
