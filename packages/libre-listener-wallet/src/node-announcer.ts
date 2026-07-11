// Direct-to-peer node_announcement sender over LDK's custom-message plumbing.
//
// PeerManager.broadcast_node_announcement never reaches a peer that didn't request a gossip
// sync (lnd doesn't, from a browser wallet with IgnoringMessageHandler routing) — the wallet
// shows as "Unknown" in the peer's node UI. This handler queues our OWN signed BOLT7
// node_announcement (wire type 257 — a well-known type, but LDK happily sends it through the
// custom-message path) addressed to specific peers; PeerManager.process_events() flushes it.
// Send-only: inbound type-257 messages are claimed by LDK's wire reader long before the custom
// reader, so `read`/`handle_custom_message` are effectively dead code kept for the interface.
//
// The 257 < 32767, so the LDK 0.1.0 sign-extended-int16 type_id binding bug (which killed the
// LSPS2-over-BOLT8 transport at type 37913) does not apply here.
import {
  CustomMessageHandler,
  CustomMessageReader,
  Type,
  TwoTuple_PublicKeyTypeZ,
  Option_TypeZ,
  NodeFeatures,
  InitFeatures,
  Result_NoneLightningErrorZ,
  Result_NoneNoneZ,
  Result_COption_TypeZDecodeErrorZ,
  type Init,
} from "lightningdevkit";
import { hexToBytes } from "./storage-cache";
import {
  encodeNodeAnnouncement,
  nextAnnouncementTimestamp,
  NODE_ANNOUNCEMENT_MSG_TYPE,
} from "./node-announcement";

export interface NodeAnnouncerOpts {
  alias: string;
  /** Called at queue time, used once per announcement for signing — never stored here. */
  getNodeSecret: () => Uint8Array;
  rgb?: Uint8Array;
  logger?: { info: (m: string) => void; error: (m: string) => void };
}

export class NodeAnnouncer {
  private outbound: Array<{ peer: Uint8Array; payload: Uint8Array }> = [];
  private lastTs = 0;

  constructor(private readonly opts: NodeAnnouncerOpts) {}

  /** Queue a freshly-signed announcement to one peer; the next process_events() sends it. */
  queueTo(peerPubkeyHex: string): void {
    try {
      const ts = nextAnnouncementTimestamp(Math.floor(Date.now() / 1000), this.lastTs);
      this.lastTs = ts;
      this.outbound.push({
        peer: hexToBytes(peerPubkeyHex),
        payload: encodeNodeAnnouncement({
          secretKey: this.opts.getNodeSecret(),
          alias: this.opts.alias,
          rgb: this.opts.rgb ?? new Uint8Array([0x7a, 0x5a, 0xf5]),
          timestamp: ts,
        }),
      });
      this.opts.logger?.info(
        `[Alias] Queued node_announcement ("${this.opts.alias}") to ${peerPubkeyHex.slice(0, 12)}…`
      );
    } catch (e) {
      this.opts.logger?.error(
        `[Alias] Failed to build node_announcement: ${e instanceof Error ? e.message : e}`
      );
    }
  }

  clear(): void {
    this.outbound.length = 0;
  }

  buildHandler(): CustomMessageHandler {
    const reader = CustomMessageReader.new_impl({
      // Send-only handler: claim no inbound custom types.
      read: (): Result_COption_TypeZDecodeErrorZ =>
        Result_COption_TypeZDecodeErrorZ.constructor_ok(Option_TypeZ.constructor_none()),
    });

    return CustomMessageHandler.new_impl(
      {
        handle_custom_message: (): Result_NoneLightningErrorZ =>
          Result_NoneLightningErrorZ.constructor_ok(),
        get_and_clear_pending_msg: (): TwoTuple_PublicKeyTypeZ[] => {
          const drained = this.outbound.splice(0);
          return drained.map(({ peer, payload }) =>
            TwoTuple_PublicKeyTypeZ.constructor_new(
              peer,
              Type.new_impl({
                type_id: () => NODE_ANNOUNCEMENT_MSG_TYPE,
                debug_str: () => "node_announcement",
                write: () => payload,
              })
            )
          );
        },
        peer_disconnected: (): void => {},
        peer_connected: (_id: Uint8Array, _msg: Init, _inbound: boolean): Result_NoneNoneZ =>
          Result_NoneNoneZ.constructor_ok(),
        provided_node_features: (): NodeFeatures => NodeFeatures.constructor_empty(),
        provided_init_features: (): InitFeatures => InitFeatures.constructor_empty(),
      },
      reader
    );
  }
}
