// Pre-flight resolution for a unilateral force-close.
//
// Force-closing broadcasts our latest commitment and ends the channel — there is no undo,
// and closing the WRONG channel is as costly as closing none. So every check that can be
// made from live channel state is made here, as pure logic, before the channel manager is
// touched at all. Keeping it out of the LDK call also keeps it testable without WASM.

/** Minimal shape needed to pick a close target — structurally satisfied by `ChannelInfo`. */
export interface ForceCloseCandidate {
  channelId: string;
  counterpartyNodeId: string;
  isUsable: boolean;
}

export type ForceCloseResolution =
  | { ok: true; channelId: string; counterpartyNodeId: string }
  | { ok: false; error: string };

const CHANNEL_ID_HEX_LEN = 64; // 32-byte channel id
const NODE_ID_HEX_LEN = 66; // 33-byte compressed pubkey

function normalizeHex(value: string, expectedLen: number): string | undefined {
  const hex = value.trim().toLowerCase();
  if (hex.length !== expectedLen) return undefined;
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  return hex;
}

/**
 * Resolve which channel a force-close should target.
 *
 * `expectedCounterparty` is the peer the CALLER believes it is closing against — pass the
 * value the UI displayed. If live state disagrees, the row was stale and we refuse rather
 * than destroy a channel the user wasn't looking at.
 *
 * Note that an unusable channel is explicitly allowed: a peer that has gone away is the
 * usual reason to force-close in the first place, since a cooperative close needs both
 * sides online to sign.
 */
export function resolveForceCloseTarget(
  channels: readonly ForceCloseCandidate[],
  channelId: string,
  expectedCounterparty?: string,
): ForceCloseResolution {
  const wanted = normalizeHex(channelId, CHANNEL_ID_HEX_LEN);
  if (!wanted) {
    return { ok: false, error: `invalid channel id (expected ${CHANNEL_ID_HEX_LEN} hex chars)` };
  }

  const matches = channels.filter((c) => c.channelId.trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    return { ok: false, error: `no channel with id ${wanted}` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `ambiguous channel id ${wanted} matched ${matches.length} channels` };
  }

  const target = matches[0];
  const liveCounterparty = normalizeHex(target.counterpartyNodeId, NODE_ID_HEX_LEN);
  if (!liveCounterparty) {
    return { ok: false, error: `channel ${wanted} has an unreadable counterparty node id` };
  }

  if (expectedCounterparty !== undefined) {
    const expected = normalizeHex(expectedCounterparty, NODE_ID_HEX_LEN);
    if (!expected) {
      return { ok: false, error: `invalid expected counterparty (expected ${NODE_ID_HEX_LEN} hex chars)` };
    }
    if (expected !== liveCounterparty) {
      return {
        ok: false,
        error: `counterparty mismatch for ${wanted}: caller expected ${expected}, live state has ${liveCounterparty}`,
      };
    }
  }

  return { ok: true, channelId: wanted, counterpartyNodeId: liveCounterparty };
}
