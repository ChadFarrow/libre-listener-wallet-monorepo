import { describe, it, expect, beforeEach } from "vitest";
import { applyNativeUiCopy } from "./native-ui";

// A minimal fixture mirroring the relevant index.html structure the helper rewrites.
function buildDom(): void {
  document.body.innerHTML = `
    <button id="d-backup"><span class="grow">Cloud backup</span></button>
    <section id="screen-backup"><h1 class="title">Cloud backup</h1></section>
    <section id="screen-dev">
      <details id="ka">
        <summary>iOS background audio (keep-alive)</summary>
        <p class="center-note">Plays a silent audio track…</p>
        <label class="toggle-row"><input type="checkbox" id="keepalive-toggle" /> Play silent background audio to keep the node alive</label>
        <p class="msg" id="keepalive-msg"></p>
      </details>
      <details id="wp">
        <summary>Web Push (offline wake)</summary>
        <button id="push-enable">Enable offline wake</button>
      </details>
    </section>`;
}

describe("applyNativeUiCopy", () => {
  beforeEach(buildDom);

  it("leaves everything untouched in the browser PWA", () => {
    applyNativeUiCopy({ native: false, localBackup: false });
    expect(document.querySelector("#d-backup .grow")?.textContent).toBe("Cloud backup");
    expect(document.querySelector("#screen-backup .title")?.textContent).toBe("Cloud backup");
    expect(document.querySelector("#ka summary")?.textContent).toBe("iOS background audio (keep-alive)");
    expect(document.getElementById("push-enable")).not.toBeNull();
  });

  it("relabels backup copy when local backup is available (independent of native)", () => {
    applyNativeUiCopy({ native: false, localBackup: true });
    expect(document.querySelector("#d-backup .grow")?.textContent).toBe("Local backup");
    expect(document.querySelector("#screen-backup .title")?.textContent).toBe("Local backup");
    // native-only tweaks did NOT run
    expect(document.querySelector("#ka summary")?.textContent).toBe("iOS background audio (keep-alive)");
    expect(document.getElementById("push-enable")).not.toBeNull();
  });

  it("relabels the keep-alive control and removes Web Push on the native APK", () => {
    applyNativeUiCopy({ native: true, localBackup: true });
    expect(document.querySelector("#ka summary")?.textContent).toBe("Background mode");
    expect(document.querySelector("#ka .center-note")?.textContent).toContain("background");
    // the toggle label text (after the checkbox) is rewritten, checkbox preserved
    const label = document.getElementById("keepalive-toggle")?.parentElement;
    expect(label?.lastChild?.textContent).toContain("Keep the node running in the background");
    expect(document.getElementById("keepalive-toggle")).not.toBeNull();
    // Web Push section removed entirely
    expect(document.getElementById("push-enable")).toBeNull();
    expect(document.getElementById("wp")).toBeNull();
  });

  it("does not throw when target elements are absent", () => {
    document.body.innerHTML = "";
    expect(() => applyNativeUiCopy({ native: true, localBackup: true })).not.toThrow();
  });
});
