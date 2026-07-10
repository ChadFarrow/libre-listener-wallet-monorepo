import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { initializeWasmFromBinary } from "lightningdevkit";
import { resolveLnAddressInvoice } from "../../lnurl-client";

function loadWasmBinary(): Uint8Array {
  const paths = [
    path.resolve(__dirname, "../../../node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "node_modules/lightningdevkit/liblightningjs.wasm"),
    path.resolve(process.cwd(), "../../node_modules/lightningdevkit/liblightningjs.wasm"),
  ];
  for (const p of paths) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error("Could not find liblightningjs.wasm");
}

beforeAll(async () => {
  await initializeWasmFromBinary(loadWasmBinary());
});

// A real regtest invoice for EXACTLY 21_000_000 msat (long expiry; decode fixtures don't
// need to be payable, only parseable).
const FIXTURE_MSAT = 21_000_000;
const FIXTURE_INVOICE =
  "lnbcrt210u1p49q3dvpp5f26shthns46ksdrtgddauy5fdmeurnv5ykqte7hp47lev8nv3flsdq4d3h82unv94nxj7r5w4ex2cqzzsxq97zvuqsp5vcq5qhh7uje6nerv8j7th25pfuer4rf76grh90qtvlf20cd55u4s9qxpqysgqecw8d5kujvcanv07tkt03ldy4zrjy86lmfsd5sg42wag504nvjxz79x9f2xvh0zhhzl5xsqukwdee9vv97qt6hp0yyg5kjusdzy93xqqhgfj8z";

// Fake fetch serving a canonical LUD-16 flow for artist@example.com and recording the URLs hit.
function fakeLnurlServer(opts?: { invoice?: string; errorAt?: "params" | "callback" }) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    seen.push(u);
    if (u === "https://example.com/.well-known/lnurlp/artist") {
      if (opts?.errorAt === "params") {
        return new Response(JSON.stringify({ status: "ERROR", reason: "no such user" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          tag: "payRequest",
          callback: "https://example.com/lnurlp/artist/cb",
          minSendable: 1000,
          maxSendable: 100_000_000,
          metadata: '[["text/plain","artist"]]',
          commentAllowed: 32,
        }),
        { status: 200 }
      );
    }
    if (u.startsWith("https://example.com/lnurlp/artist/cb?")) {
      if (opts?.errorAt === "callback") {
        return new Response(JSON.stringify({ status: "ERROR", reason: "amount out of range" }), { status: 200 });
      }
      return new Response(JSON.stringify({ pr: opts?.invoice ?? FIXTURE_INVOICE }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("resolveLnAddressInvoice", () => {
  it("resolves an address to an amount-verified invoice via the LUD-16 flow", async () => {
    const { fetchImpl, seen } = fakeLnurlServer();
    const r = await resolveLnAddressInvoice({
      address: "artist@example.com",
      amountMsat: FIXTURE_MSAT,
      comment: "go pod go",
      fetchImpl,
    });
    expect(r.invoice).toBe(FIXTURE_INVOICE);
    expect(seen[0]).toBe("https://example.com/.well-known/lnurlp/artist");
    expect(seen[1]).toBe("https://example.com/lnurlp/artist/cb?amount=21000000&comment=go%20pod%20go");
  });

  it("rejects an invoice whose amount differs from the request (overcharge guard)", async () => {
    const { fetchImpl } = fakeLnurlServer();
    await expect(
      resolveLnAddressInvoice({ address: "artist@example.com", amountMsat: 22_000_000, fetchImpl })
    ).rejects.toThrow(/amount mismatch/i);
  });

  it("rejects an unparseable invoice", async () => {
    const { fetchImpl } = fakeLnurlServer({ invoice: "lnbcrtgarbage" });
    await expect(
      resolveLnAddressInvoice({ address: "artist@example.com", amountMsat: FIXTURE_MSAT, fetchImpl })
    ).rejects.toThrow(/unparseable/i);
  });

  it("surfaces the server's LNURL error reasons", async () => {
    const a = fakeLnurlServer({ errorAt: "params" });
    await expect(
      resolveLnAddressInvoice({ address: "artist@example.com", amountMsat: FIXTURE_MSAT, fetchImpl: a.fetchImpl })
    ).rejects.toThrow(/no such user/);
    const b = fakeLnurlServer({ errorAt: "callback" });
    await expect(
      resolveLnAddressInvoice({ address: "artist@example.com", amountMsat: FIXTURE_MSAT, fetchImpl: b.fetchImpl })
    ).rejects.toThrow(/amount out of range/);
  });

  it("throws on a non-2xx endpoint response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(
      resolveLnAddressInvoice({ address: "artist@example.com", amountMsat: FIXTURE_MSAT, fetchImpl })
    ).rejects.toThrow(/404/);
  });
});
