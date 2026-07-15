import { UserConfig } from "lightningdevkit";

export interface UserConfigOptions {
  /** minimum_depth for an inbound CONFIRMED channel we're the fundee of (already resolved/clamped). */
  minimumDepth: number;
  /** Announce (make public) our channels. Must match the counterparty's preference. */
  announceChannels: boolean;
}

/**
 * Builds the LDK `UserConfig` the node starts with. Extracted from `start()` so the on-disk-invisible
 * handshake policy is unit-testable against the real LDK bindings.
 */
export function buildUserConfig(opts: UserConfigOptions): UserConfig {
  const userConfig = UserConfig.constructor_default();
  userConfig.set_manually_accept_inbound_channels(true);
  const handshake = userConfig.get_channel_handshake_config();
  handshake.set_negotiate_anchors_zero_fee_htlc_tx(true);
  handshake.set_minimum_depth(opts.minimumDepth);
  handshake.set_announce_for_forwarding(opts.announceChannels);
  // Accept a single inbound HTLC up to the FULL channel capacity. LDK defaults this to 10%, which on
  // a small channel (e.g. 25k) caps one incoming payment at 2,500 sats — larger receives then fail
  // "no route" at the payer (this looks exactly like a routing/topology bug but isn't; diagnosed live
  // 2026-07-15). NOTE: max_htlc_value_in_flight is negotiated at channel-open and fixed for the
  // channel's life, so this only lifts the cap on channels opened AFTER this ships.
  handshake.set_max_inbound_htlc_value_in_flight_percent_of_channel(100);
  // Accept HTLCs worth less than the invoice amount by the LSP's skimmed opening fee — required for
  // LSPS2 JIT, where the LSP deducts its fee from the first incoming payment before forwarding.
  const channelConfig = userConfig.get_channel_config();
  channelConfig.set_accept_underpaying_htlcs(true);
  userConfig.set_channel_config(channelConfig);
  return userConfig;
}
