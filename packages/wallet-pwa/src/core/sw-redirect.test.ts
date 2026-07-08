import { describe, it, expect } from "vitest";
import { cleanRedirect } from "./sw-redirect";

// jsdom/Node won't let us construct a genuinely-redirected Response (the flag is read-only and
// always false on a constructed one), so fake the shape cleanRedirect reads off the network response.
function fakeRedirected(bodyText: string): Response {
  return {
    redirected: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/html", "x-keep": "1" }),
    arrayBuffer: async () => new TextEncoder().encode(bodyText).buffer,
  } as unknown as Response;
}

describe("cleanRedirect", () => {
  it("rebuilds a redirected response so the redirected flag is cleared (the Safari-nav fix)", async () => {
    const cleaned = await cleanRedirect(fakeRedirected("<!doctype html><title>ok</title>"));
    expect(cleaned.redirected).toBe(false); // the whole point — a constructed Response is never redirected
    expect(cleaned.status).toBe(200);
    expect(cleaned.statusText).toBe("OK");
    expect(await cleaned.text()).toBe("<!doctype html><title>ok</title>");
    expect(cleaned.headers.get("content-type")).toBe("text/html");
    expect(cleaned.headers.get("x-keep")).toBe("1"); // headers preserved
  });

  it("returns a non-redirected response unchanged (no needless copy)", async () => {
    const res = new Response("<html>x</html>", { status: 200 });
    expect(res.redirected).toBe(false);
    await expect(cleanRedirect(res)).resolves.toBe(res);
  });
});
