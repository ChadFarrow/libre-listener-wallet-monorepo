import { parseLightningAddress } from "@libre/shared";

// Classify what the user pasted into the Send screen. Pure — no fetching, no invoice
// decoding (amount/network validation happens in the SDK's payBolt11 / lnurl-client).
export type SendInput =
  | { kind: "bolt11"; value: string }
  | { kind: "lnaddress"; value: string }
  | { kind: "invalid" };

export function classifySendInput(raw: string): SendInput {
  let s = (raw || "").trim();
  if (/^lightning:/i.test(s)) s = s.slice("lightning:".length);
  const lower = s.toLowerCase();
  // BOLT11 HRP: lnbc (mainnet), lntb (testnet), lnbcrt (regtest — also matches the lnbc
  // prefix, which is fine). QR payloads are often uppercase; bech32 is case-insensitive.
  if (/^ln(bc|tb)/.test(lower)) return { kind: "bolt11", value: lower };
  try {
    const addr = parseLightningAddress(s);
    return { kind: "lnaddress", value: `${addr.name}@${addr.domain}` };
  } catch {
    return { kind: "invalid" };
  }
}
