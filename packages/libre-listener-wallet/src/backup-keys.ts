// ⚠️ STORAGE CONTRACT — the top-level (non-KVStore) storage keys copied verbatim
// into an encrypted backup. These are the IRREPLACEABLE bits of wallet state: dropping
// one (e.g. `channel_manager`) yields a backup that can't reopen the channel (fund loss).
// The KVStore-managed keys (channel monitors) are appended at export time from
// `ldk_keys_index`. Pinned by storage-contract.test.ts.
//
// `network_graph` and `scorer` are DELIBERATELY excluded: they're re-derivable (the graph
// re-syncs from RGS and rebuilds from gossip; the scorer rebuilds over use), and the graph
// alone is ~20MB+ — bundling it made every backup huge and slow. On restore they're simply
// absent and `start()` creates fresh ones (it already handles a first-ever start with no
// graph). Backward-compatible: older backups that DO contain them still restore fine (the
// entries are just written back). No migration needed because their absence isn't fund-loss.
//
// `peer_addresses` (pubkey→{host,port}) is included — NOT for fund-safety (its absence never
// loses funds) but so a restore onto a fresh device can auto-reconnect EVERY channel peer.
// LDK stores no peer addresses, so start()'s `redialChannelPeers()` has nothing to dial after
// a restore unless the address book comes along; without it a channel opened to a non-default
// peer (e.g. an LSP) stays offline until a manual reconnect. It's tiny (a few entries) and
// additive: older backups simply lack the key (restore falls back to the configured peer).
//
// `node_alias` (the user-set BOLT7 node name shown to peers) is included for the same reason as
// peer_addresses — NOT fund-safety, but so the name follows the wallet across devices. It's a
// single small string set by the app; only the alias is backed up, never the device-specific
// endpoints/peer that live alongside it in the app's ldk_config. Additive + backward-compatible:
// older backups simply lack the key and restore fine (the golden envelopes below have no
// node_alias and must keep decrypting).
//
// `nwc_wallet_private_key` + `nwc_connections` (the NWC wallet-service identity apps pair to, and
// the paired-app list with per-connection secret/permissions/budget) are included so app pairings
// follow the wallet across devices: a restore keeps the SAME NWC wallet pubkey, so already-paired
// apps (Alby Go, stablekraft, …) reach the restored device WITHOUT re-pairing, with the same
// permission/budget config. These are spend-authority secrets, but the backup is seed-encrypted
// and already carries the seed itself (full fund control) — they're the same class of secret,
// encrypted identically, so this doesn't widen the trust boundary (guardrails §"key isolation":
// secrets leave only inside a locally-encrypted backup). Additive + backward-compatible: an older
// backup lacks them and restores fine (init() then mints a fresh NWC identity, as it does today).
// MAX_NWC_CONNECTIONS caps nwc_connections at 10 entries, so it stays tiny.
//
// NOTE on payment history: the `tx_*` records (PaymentLogger, one per payment) are NOT listed
// here — they're dynamic, unbounded keys, so like the channel-monitor keys they're ENUMERATED
// and appended at export time (exportState, gated on storage.keys()). Additive + not fund-
// critical: older backups lack them and restore fine; a restore onto a fresh device now carries
// the transaction list so history follows the wallet instead of resetting.
export const BACKUP_DIRECT_KEYS = [
  "ldk_seed",
  "channel_manager",
  "ldk_keys_index",
  "state_version",
  "peer_addresses",
  "node_alias",
  "nwc_wallet_private_key",
  "nwc_connections",
] as const;
