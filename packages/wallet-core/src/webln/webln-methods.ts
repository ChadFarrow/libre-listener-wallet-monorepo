// The WebLN method surface a page may invoke — the ONLY wallet entry points reachable from
// host-page code, in the extension (via the content-script relay) and in the embeddable widget
// (via the in-page provider) alike. Extracted from the extension's messages.ts so both consumers
// gate on the same list. Everything else (backup export, wallet create, NWC pairing…) is
// control-plane and must never be page-reachable.
export const WEBLN_METHODS = ["enable", "isEnabled", "getInfo", "makeInvoice", "sendPayment", "keysend"] as const;
export type WeblnMethod = (typeof WEBLN_METHODS)[number];

// Methods that move money — subject to per-origin spending caps + serialization.
export const WEBLN_SPENDING_METHODS: WeblnMethod[] = ["sendPayment", "keysend"];
