// Pure BOLT7 node_announcement (wire type 257) encoder + the announce-scheduling decision.
//
// Why this exists: LDK's PeerManager.broadcast_node_announcement only forwards to peers that
// REQUESTED a gossip sync (sent gossip_timestamp_filter). lnd never requests one from a
// no-gossip-features browser wallet (route handler = IgnoringMessageHandler), so the broadcast
// silently reaches zero peers and the wallet shows as "Unknown" in the peer's node UI — proven
// by lnd PEER=trace wire logs. The fix is to hand this payload to LDK's custom-message sender,
// which delivers it DIRECTLY to each connected peer; lnd stores the alias once the node is in
// its local graph (which its own private channel to us puts it in).
//
// Key isolation: the node secret is a parameter, used once for signing, stored nowhere.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const NODE_ANNOUNCEMENT_MSG_TYPE = 257;

export interface NodeAnnouncementOpts {
  secretKey: Uint8Array; // 32-byte node secret (signs; its pubkey becomes node_id)
  alias: string; // display name; UTF-8, truncated to 32 bytes
  rgb: Uint8Array; // 3-byte node color
  timestamp: number; // unix seconds; peers ignore announcements <= their stored timestamp
}

/**
 * Encode the node_announcement payload (everything AFTER the 2-byte wire type):
 * sig(64) | flen(2)=0 | timestamp(4) | node_id(33) | rgb(3) | alias(32) | addrlen(2)=0.
 * The signature is compact ECDSA over the double-SHA256 of the remainder, per BOLT7.
 * No features and no addresses: a browser wallet advertises nothing and cannot be dialed.
 */
export function encodeNodeAnnouncement(opts: NodeAnnouncementOpts): Uint8Array {
  if (opts.secretKey.length !== 32) throw new Error("node secret must be 32 bytes");
  if (opts.rgb.length !== 3) throw new Error("rgb must be 3 bytes");
  const nodeId = secp256k1.getPublicKey(opts.secretKey, true);

  const aliasBytes = new Uint8Array(32);
  aliasBytes.set(new TextEncoder().encode(opts.alias).slice(0, 32));

  // flen(2) + features(0) + timestamp(4) + node_id(33) + rgb(3) + alias(32) + addrlen(2)
  const body = new Uint8Array(2 + 4 + 33 + 3 + 32 + 2);
  const view = new DataView(body.buffer);
  view.setUint16(0, 0); // flen = 0
  view.setUint32(2, opts.timestamp >>> 0);
  body.set(nodeId, 6);
  body.set(opts.rgb, 39);
  body.set(aliasBytes, 42);
  view.setUint16(74, 0); // addrlen = 0

  const digest = sha256(sha256(body));
  const sig = secp256k1.sign(digest, opts.secretKey, { prehash: false, format: "compact" });

  const out = new Uint8Array(64 + body.length);
  out.set(sig, 0);
  out.set(body, 64);
  return out;
}

/** Strictly-increasing announcement timestamp: peers drop a timestamp <= the one they hold. */
export function nextAnnouncementTimestamp(nowSec: number, lastTs: number): number {
  return Math.max(nowSec, lastTs + 1);
}

/**
 * Which connected peers need a (re-)announcement this tick, and the state to carry forward.
 * Announce when a peer is newly seen, and AGAIN when its channel first becomes ready: lnd
 * discards announcements for nodes not in its graph, and only its own (private) channel to us
 * puts us there — so the pre-channel announcement is dropped and must be re-sent. State for
 * absent peers is dropped so a reconnect re-announces with a fresh timestamp.
 */
export function peersNeedingAnnouncement(
  prev: Map<string, boolean>, // pubkey hex -> hadReadyChannel at last announce
  connected: string[],
  readyChannelPeers: Set<string>
): { peers: string[]; next: Map<string, boolean> } {
  const peers: string[] = [];
  const next = new Map<string, boolean>();
  for (const p of connected) {
    const ready = readyChannelPeers.has(p);
    const last = prev.get(p);
    if (last === undefined || (ready && !last)) {
      peers.push(p);
      next.set(p, ready);
    } else {
      next.set(p, last || ready);
    }
  }
  return { peers, next };
}
