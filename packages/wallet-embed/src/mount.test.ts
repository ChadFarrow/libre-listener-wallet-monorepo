import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { mountLibreWallet } from "./index";

describe("mountLibreWallet", () => {
  it("validates required options up front", () => {
    expect(() => mountLibreWallet(document.body, { googleClientId: "", wasmUrl: "/x.wasm" })).toThrow(/googleClientId/);
    expect(() => mountLibreWallet(document.body, { googleClientId: "cid", wasmUrl: "" })).toThrow(/wasmUrl/);
    expect(() => mountLibreWallet("#nope", { googleClientId: "cid", wasmUrl: "/x.wasm" })).toThrow(/target not found/);
  });

  it("mounts the element, lands on the Connect view (Drive not connected), and disposes cleanly", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = mountLibreWallet(host, {
      googleClientId: "cid.apps.googleusercontent.com",
      wasmUrl: "/liblightningjs.wasm",
      network: "regtest",
      appName: "demo-host",
    });
    expect(host.querySelector("libre-wallet")).toBe(handle.element);
    // The entry flow is async (checks Drive) — wait a tick for renderConnect.
    await new Promise((r) => setTimeout(r, 20));
    const shadow = (handle.element as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot;
    expect(shadow.textContent).toContain("Connect Libre Wallet");
    expect(handle.state().view).toBe("stopped"); // no session booted without Drive

    // webln surface exists but a spend needs user approval — cancel the modal → clean rejection
    const spend = handle.webln.keysend({ destination: "02" + "ab".repeat(32), amount: 1 });
    await new Promise((r) => setTimeout(r, 10)); // let the modal render
    (shadow.querySelector(".overlay button.secondary") as HTMLButtonElement).click();
    await expect(spend).rejects.toThrow(/rejected/i);

    await handle.dispose();
    expect(host.querySelector("libre-wallet")).toBeNull();
  });

  it("does not install window.webln unless asked, and installs politely when asked", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const h1 = mountLibreWallet(host, { googleClientId: "cid", wasmUrl: "/w.wasm", network: "regtest" });
    expect((window as { webln?: unknown }).webln).toBeUndefined();
    expect(h1.installedWebln).toBe(false);
    await h1.dispose();

    const h2 = mountLibreWallet(host, { googleClientId: "cid", wasmUrl: "/w.wasm", network: "regtest", installWebln: true });
    expect((window as { webln?: unknown }).webln).toBe(h2.webln);
    expect(h2.installedWebln).toBe(true);

    // dispose must take the provider back down with it — a host still holding window.webln would
    // otherwise be calling into a torn-down session.
    await h2.dispose();
    expect((window as { webln?: unknown }).webln).toBeUndefined();
  });

  // The install is polite, so a host CANNOT infer "window.webln is truthy" => "it's us". A host that
  // did would route payments to the incumbent wallet while labelling them ours.
  it("reports installedWebln:false when another provider already owns window.webln, and leaves it alone", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const incumbent = { id: "alby" };
    (window as { webln?: unknown }).webln = incumbent;

    const h = mountLibreWallet(host, { googleClientId: "cid", wasmUrl: "/w.wasm", network: "regtest", installWebln: true });
    expect(h.installedWebln).toBe(false);
    expect((window as { webln?: unknown }).webln).toBe(incumbent);
    expect(h.webln).not.toBe(incumbent); // the real wallet is only reachable via the handle

    // dispose only removes what it installed — never someone else's provider.
    await h.dispose();
    expect((window as { webln?: unknown }).webln).toBe(incumbent);
    delete (window as { webln?: unknown }).webln;
  });
});
