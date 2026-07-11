import { describe, it, expect, beforeEach } from "vitest";
import { resolveManifestHref, urlHasDemo, enterDemoFromUrl, isDemoMode } from "./demo-mode";

describe("urlHasDemo (query + iOS-preserved hash)", () => {
  it("detects the ?demo query", () => {
    expect(urlHasDemo("?demo", "")).toBe(true);
    expect(urlHasDemo("?demo=1", "")).toBe(true);
    expect(urlHasDemo("?foo=bar&demo", "")).toBe(true);
  });

  it("detects the #demo hash — the carrier iOS keeps when it strips the query from start_url", () => {
    expect(urlHasDemo("", "#demo")).toBe(true);
    expect(urlHasDemo("", "#demo&x=1")).toBe(true);
    // iOS launch of start_url "./?demo#demo" after stripping the query → search empty, hash kept
    expect(urlHasDemo("", "#demo")).toBe(true);
  });

  it("is false when neither carries demo", () => {
    expect(urlHasDemo("", "")).toBe(false);
    expect(urlHasDemo("?foo=bar", "#home")).toBe(false);
    expect(urlHasDemo("?demonstrate=1", "#demoish")).toBe(false);
  });
});

describe("enterDemoFromUrl (the per-tab demo latch)", () => {
  beforeEach(() => sessionStorage.clear());

  it("enters demo when the URL carries the marker", () => {
    enterDemoFromUrl("?demo", "");
    expect(isDemoMode()).toBe(true);
  });

  it("stays in demo across a reload that keeps the marker in the URL", () => {
    enterDemoFromUrl("?demo", "");
    enterDemoFromUrl("?demo", "");
    expect(isDemoMode()).toBe(true);
  });

  it("clears a stale latch when the URL has no marker — the plain URL must boot the REAL app", () => {
    // A tab that once visited ?demo latched sessionStorage; navigating to the bare URL in the
    // same tab (or a session-restored/duplicated tab) must NOT keep booting demo — this hid the
    // real app and blocked Google Drive on the live site (desktop, 2026-07-11).
    enterDemoFromUrl("?demo", "");
    expect(isDemoMode()).toBe(true);
    enterDemoFromUrl("", "");
    expect(isDemoMode()).toBe(false);
  });
});

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
