import { describe, it, expect } from "vitest";
import { VssClient, VssError, isVssConflict, isVssNotFound } from "../../vss-client";
import {
  encodeKeyValue,
  encodeGetObjectRequest,
  decodeListKeyVersionsResponse,
  VSS_ERROR_CODE,
  type VssKeyValue,
} from "../../vss-protobuf";

// Build the on-wire bytes a real vss-server would return for a GetObjectResponse (value in field 2).
function getObjectResponseBytes(kv: VssKeyValue): Uint8Array {
  const inner = encodeKeyValue(kv);
  return Uint8Array.from([0x12, inner.length, ...inner]);
}
function errorResponseBytes(code: number, message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  return Uint8Array.from([0x08, code, 0x12, msg.length, ...msg]);
}
function listResponseBytes(items: VssKeyValue[], nextPageToken?: string): Uint8Array {
  const parts: number[] = [];
  for (const kv of items) {
    const inner = encodeKeyValue(kv);
    parts.push(0x0a, inner.length, ...inner);
  }
  if (nextPageToken) {
    const t = new TextEncoder().encode(nextPageToken);
    parts.push(0x12, t.length, ...t);
  }
  return Uint8Array.from(parts);
}

function recordingFetch(handler: (url: string, bodyBytes: Uint8Array) => Response) {
  const calls: { url: string; method: string; contentType?: string; body: Uint8Array }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(0);
    calls.push({
      url,
      method: init?.method ?? "GET",
      contentType: (init?.headers as Record<string, string> | undefined)?.["content-type"],
      body,
    });
    return handler(url, body);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const client = (fetchImpl: typeof fetch) =>
  new VssClient({ baseUrl: "https://vss.test/vss/", storeId: "store-1", fetchImpl });

describe("VssClient.getObject", () => {
  it("POSTs protobuf to /getObject and decodes the value", async () => {
    const { impl, calls } = recordingFetch(() =>
      new Response(getObjectResponseBytes({ key: "channel_manager", version: 12, value: Uint8Array.from([1, 2, 3]) }), {
        status: 200,
      }),
    );
    const got = await client(impl).getObject("channel_manager");
    expect(got).not.toBeNull();
    expect(got!.version).toBe(12);
    expect(Array.from(got!.value)).toEqual([1, 2, 3]);

    // trailing slash collapsed, correct path + content-type, and the request body is a real
    // GetObjectRequest(store_id, key).
    expect(calls[0].url).toBe("https://vss.test/vss/getObject");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].contentType).toBe("application/octet-stream");
    expect(Array.from(calls[0].body)).toEqual(Array.from(encodeGetObjectRequest("store-1", "channel_manager")));
  });

  it("returns null when the key does not exist (NoSuchKeyException)", async () => {
    const { impl } = recordingFetch(() =>
      new Response(errorResponseBytes(VSS_ERROR_CODE.NoSuchKeyException, "no such key"), { status: 404 }),
    );
    expect(await client(impl).getObject("missing")).toBeNull();
  });
});

describe("VssClient.putObjects", () => {
  it("sends the batch and resolves on 200", async () => {
    const { impl, calls } = recordingFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    await client(impl).putObjects([{ key: "seed", version: 0, value: Uint8Array.from([9, 9]) }]);
    expect(calls[0].url).toBe("https://vss.test/vss/putObjects");
    expect(calls[0].body.length).toBeGreaterThan(0);
  });

  it("throws a conflict error on a stale version (409 / ConflictException)", async () => {
    const { impl } = recordingFetch(() =>
      new Response(errorResponseBytes(VSS_ERROR_CODE.ConflictException, "version mismatch"), { status: 409 }),
    );
    let thrown: unknown;
    try {
      await client(impl).putObjects([{ key: "channel_manager", version: 3, value: new Uint8Array(0) }]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VssError);
    expect(isVssConflict(thrown)).toBe(true);
    expect(isVssNotFound(thrown)).toBe(false);
    expect((thrown as VssError).message).toContain("version mismatch");
  });

  it("surfaces a non-protobuf error body without crashing the decoder", async () => {
    const { impl } = recordingFetch(() => new Response("<html>502 bad gateway</html>", { status: 502 }));
    let thrown: unknown;
    try {
      await client(impl).putObjects([{ key: "k", version: 0, value: new Uint8Array(0) }]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VssError);
    expect((thrown as VssError).httpStatus).toBe(502);
    expect(isVssConflict(thrown)).toBe(false);
  });
});

describe("VssClient.listAllKeyVersions", () => {
  it("follows nextPageToken across pages and concatenates", async () => {
    let call = 0;
    const { impl, calls } = recordingFetch(() => {
      call++;
      if (call === 1) {
        return new Response(listResponseBytes([{ key: "a", version: 1, value: new Uint8Array(0) }], "page2"), {
          status: 200,
        });
      }
      return new Response(listResponseBytes([{ key: "b", version: 5, value: new Uint8Array(0) }]), { status: 200 });
    });
    const all = await client(impl).listAllKeyVersions("tx_");
    expect(all.map((k) => [k.key, k.version])).toEqual([
      ["a", 1],
      ["b", 5],
    ]);
    expect(calls).toHaveLength(2);
    // the first page's response really did advance a token (sanity on our fixture decoder)
    const firstResp = decodeListKeyVersionsResponse(
      listResponseBytes([{ key: "a", version: 1, value: new Uint8Array(0) }], "page2"),
    );
    expect(firstResp.nextPageToken).toBe("page2");
  });
});
