// @libre/wallet-core — the headless wallet application layer shared by the PWA, the browser
// extension, and the embeddable widget. Extracted verbatim from @libre/wallet-pwa (2026-07-15);
// the on-disk storage contract these modules define is pinned by src/storage-contract.test.ts and
// the per-app contract suites — moving the code changed NO persisted key, DB name, or format.
export * from "./wallet-controller";
export * from "./controller-api";
export * from "./drive-backup";
export * from "./core/storage-namespace";
export * from "./core/wallet-config";
export * from "./core/sw-config";
export * from "./core/ws-provider";
export * from "./core/restore-guard";
export * from "./core/backup-ahead";
export * from "./core/state-version-mirror";
export * from "./core/start-retry";
export * from "./core/send-input";
export * from "./core/nwc-connection-view";
export * from "./core/peer-list";
export * from "./core/address-script";
export * from "./core/usable-smoothing";
export * from "./core/drive-redirect";
export * from "./core/drive-sync-policy";
// Roaming wallet: one wallet that MOVES between origins over the Drive backup, with a Drive-file
// lease as the cross-origin single-instance guard (see docs/roaming-protocol.md).
export * from "./roaming/roaming-policy";
export * from "./roaming/drive-lease";
export * from "./roaming/roaming-session";
// Portable WebLN layer (extracted from the browser extension): the page-facing method gate,
// the WebLN→WalletRpc mapping, and the per-origin permission/spending-cap store.
export * from "./webln/webln-methods";
export * from "./webln/webln-gate";
export * from "./webln/webln-mapping";
export * from "./webln/permission-store";
export * from "./webln/cap-input";
export * from "./webln/approval-grant";
export * from "./webln/bolt11-amount";
export * from "./webln/settlement-pending";
