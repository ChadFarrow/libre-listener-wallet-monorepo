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
export const BACKUP_DIRECT_KEYS = [
  "ldk_seed",
  "channel_manager",
  "ldk_keys_index",
  "state_version",
] as const;
