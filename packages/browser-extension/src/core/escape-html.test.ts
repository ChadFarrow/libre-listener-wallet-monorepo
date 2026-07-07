import { describe, it, expect } from "vitest";
import { escapeHtml } from "./escape-html";

// Fix 3: the options-page grants table interpolates the grant origin into innerHTML. An origin is
// attacker-influenced (a page picks the origin it calls webln.enable() from), so it must be escaped
// before innerHTML — the same treatment tx-history notes already get.
describe("escapeHtml", () => {
  it("escapes the HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert('x')&"y"`)).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&amp;&quot;y&quot;"
    );
  });

  it("neutralizes a would-be tag in an origin-shaped string", () => {
    const out = escapeHtml(`https://evil.example/<img src=x onerror=alert(1)>`);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("leaves a plain origin untouched", () => {
    expect(escapeHtml("https://example.com")).toBe("https://example.com");
  });
});
