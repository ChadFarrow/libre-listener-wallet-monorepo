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
] as const;
