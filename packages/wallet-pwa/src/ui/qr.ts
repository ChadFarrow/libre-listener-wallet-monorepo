import QRCode from "qrcode";

// Render a QR into an <img> on-device (bundled qrcode). Secret-bearing payloads (invoices,
// NWC pairing URIs) must NEVER go to a third-party QR image service. Best-effort: a render
// failure logs and leaves the image hidden — the copyable text is always present beside it.
export async function renderQr(img: HTMLImageElement, text: string): Promise<boolean> {
  try {
    img.src = await QRCode.toDataURL(text, { width: 240, margin: 1 });
    img.classList.remove("hidden");
    return true;
  } catch (e) {
    console.warn("[QR] could not render:", (e as Error)?.message || e);
    img.classList.add("hidden");
    return false;
  }
}
