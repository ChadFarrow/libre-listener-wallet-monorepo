import { describe, it, expect } from "vitest";
import { resolveManifestHref } from "./demo-mode";

describe("resolveManifestHref (demo home-screen install)", () => {
  it("swaps only the filename, preserving the Vite base directory", () => {
    expect(resolveManifestHref("manifest.webmanifest")).toBe("manifest-demo.webmanifest");
    expect(resolveManifestHref("/manifest.webmanifest")).toBe("/manifest-demo.webmanifest");
    expect(resolveManifestHref("./manifest.webmanifest")).toBe("./manifest-demo.webmanifest");
    expect(resolveManifestHref("/some/base/manifest.webmanifest")).toBe("/some/base/manifest-demo.webmanifest");
  });

  it("falls back to the default filename when the href is missing", () => {
    expect(resolveManifestHref(null)).toBe("manifest-demo.webmanifest");
    expect(resolveManifestHref(undefined)).toBe("manifest-demo.webmanifest");
    expect(resolveManifestHref("")).toBe("manifest-demo.webmanifest");
  });
});
