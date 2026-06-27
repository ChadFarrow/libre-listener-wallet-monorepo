// Minimal NWC (NIP-47) client to test the wallet's NWC service end-to-end.
// Usage: node nwc-client.mjs "<nwc-uri>" <method> [json-params]
//   node nwc-client.mjs "nostr+walletconnect://..." get_info
//   node nwc-client.mjs "..." get_balance
//   node nwc-client.mjs "..." make_invoice '{"amount":2000000,"description":"test"}'
//   node nwc-client.mjs "..." pay_keysend '{"pubkey":"<hex>","amount":1000000}'
// (amounts are msat). Run from packages/libre-listener-wallet so nostr-tools resolves.
import { Relay, nip04, finalizeEvent, getPublicKey } from "nostr-tools";

function hexToBytes(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return a;
}

const uri = process.argv[2];
const method = process.argv[3] || "get_info";
const params = process.argv[4] ? JSON.parse(process.argv[4]) : {};

const m = uri.match(/^nostr\+walletconnect:\/\/([0-9a-fA-F]{64})\?(.*)$/);
if (!m) { console.error("Bad NWC URI"); process.exit(1); }
const walletPubkey = m[1].toLowerCase();
const sp = new URLSearchParams(m[2]);
const relayUrl = sp.get("relay");
const secret = sp.get("secret");
const secretBytes = hexToBytes(secret);
const clientPubkey = getPublicKey(secretBytes);

console.log(`[client] wallet=${walletPubkey.slice(0, 12)}… relay=${relayUrl} client=${clientPubkey.slice(0, 12)}…`);
console.log(`[client] method=${method} params=${JSON.stringify(params)}`);

const reqContent = await nip04.encrypt(secret, walletPubkey, JSON.stringify({ method, params }));
const reqEvent = finalizeEvent(
  { kind: 23194, tags: [["p", walletPubkey]], content: reqContent, created_at: Math.floor(Date.now() / 1000) },
  secretBytes
);

const relay = await Relay.connect(relayUrl);
console.log(`[client] connected to relay; subscribing for response to event ${reqEvent.id.slice(0, 12)}…`);

let done = false;
relay.subscribe([{ kinds: [23195], "#e": [reqEvent.id] }], {
  onevent: async (e) => {
    if (done) return;
    done = true;
    try {
      const plain = await nip04.decrypt(secret, walletPubkey, e.content);
      console.log("\n✅ RESPONSE:\n" + JSON.stringify(JSON.parse(plain), null, 2));
    } catch (err) {
      console.log("\n⚠️ decrypt/parse failed:", err.message, "\nraw:", e.content);
    }
    relay.close();
    process.exit(0);
  },
});

await relay.publish(reqEvent);
console.log("[client] request published; waiting up to 20s for response…");
setTimeout(() => { if (!done) { console.log("\n❌ TIMEOUT — no response (is the wallet running + connection created?)"); process.exit(1); } }, 20000);
