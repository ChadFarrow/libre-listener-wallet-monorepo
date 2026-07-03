import { describe, it, expect } from "vitest";
import { isFromExtensionContext } from "./sender-guard";

const ID = "abcdefghijklmnop";
const PREFIX = `chrome-extension://${ID}/`;

describe("isFromExtensionContext", () => {
  it("accepts the extension's own pages (popup/options/approval) — even when tab-hosted", () => {
    // The approval window is opened via windows.create → it IS in a tab, but its url is our origin.
    expect(isFromExtensionContext({ id: ID, url: `${PREFIX}approval.html?origin=x` }, ID, PREFIX)).toBe(true);
    expect(isFromExtensionContext({ id: ID, url: `${PREFIX}options.html` }, ID, PREFIX)).toBe(true);
    expect(isFromExtensionContext({ id: ID, url: `${PREFIX}popup.html` }, ID, PREFIX)).toBe(true);
  });

  it("accepts the extension's worker contexts (background / offscreen)", () => {
    expect(isFromExtensionContext({ id: ID, url: `${PREFIX}background.js` }, ID, PREFIX)).toBe(true);
    expect(isFromExtensionContext({ id: ID, url: `${PREFIX}offscreen.html` }, ID, PREFIX)).toBe(true);
  });

  it("rejects a content script (our id, but a web-page url)", () => {
    expect(isFromExtensionContext({ id: ID, url: "http://127.0.0.1:8899/" }, ID, PREFIX)).toBe(false);
    expect(isFromExtensionContext({ id: ID, url: "https://evil.example/" }, ID, PREFIX)).toBe(false);
  });

  it("rejects another extension and missing/spoofed fields", () => {
    expect(isFromExtensionContext({ id: "other", url: `chrome-extension://other/x.html` }, ID, PREFIX)).toBe(false);
    expect(isFromExtensionContext({ id: ID, url: undefined }, ID, PREFIX)).toBe(false);
    expect(isFromExtensionContext(undefined, ID, PREFIX)).toBe(false);
    // A url that merely contains, but doesn't start with, our prefix.
    expect(isFromExtensionContext({ id: ID, url: `http://evil/${PREFIX}` }, ID, PREFIX)).toBe(false);
  });
});
