// Demo host page for local development of the embed (regtest by default). This file plays the
// role of the embedding app (boostmebitch): it mounts the widget and drives window.webln.
import { mountLibreWallet } from "../src/index";

const params = new URLSearchParams(location.search);
const network = (params.get("network") as "mainnet" | "regtest" | null) ?? "regtest";

const handle = mountLibreWallet("#wallet-slot", {
  // Same localStorage override the PWA supports; falls back to the shared dev client id pattern.
  googleClientId: localStorage.getItem("libre_google_client_id") || "REPLACE_WITH_GOOGLE_CLIENT_ID",
  wasmUrl: "/liblightningjs.wasm",
  network,
  appName: "embed-demo",
  installWebln: true,
});

handle.onState((s) => console.log("[demo] roaming state:", s));

const out = document.querySelector<HTMLPreElement>("#out")!;
const show = (v: unknown) => (out.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2));
const webln = () => (window as unknown as { webln: typeof handle.webln }).webln ?? handle.webln;

document.querySelector("#btn-info")!.addEventListener("click", () => {
  webln().getInfo().then(show, (e) => show(`Error: ${(e as Error).message}`));
});
document.querySelector("#btn-invoice")!.addEventListener("click", () => {
  webln().makeInvoice({ amount: 21, defaultMemo: "embed demo" }).then(show, (e) => show(`Error: ${(e as Error).message}`));
});
document.querySelector("#btn-keysend")!.addEventListener("click", () => {
  const destination = prompt("Destination node pubkey (66-hex):") ?? "";
  webln()
    .keysend({ destination, amount: 10, customRecords: { 7629169: JSON.stringify({ app_name: "embed-demo" }) } })
    .then(show, (e) => show(`Error: ${(e as Error).message}`));
});
