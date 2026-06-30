// ⚠️ STORAGE CONTRACT — the top-level (non-KVStore) storage keys copied verbatim
// into an encrypted backup. Removing one makes restored wallets miss that state —
// e.g. dropping `channel_manager` yields a backup that can't reopen the channel
// (fund loss). The KVStore-managed keys (channel monitors) are appended at export
// time from `ldk_keys_index`. Changing this set requires a migration, not an edit.
// Pinned by storage-contract.test.ts.
export const BACKUP_DIRECT_KEYS = [
  "ldk_seed",
  "channel_manager",
  "network_graph",
  "scorer",
  "ldk_keys_index",
  "state_version",
] as const;
