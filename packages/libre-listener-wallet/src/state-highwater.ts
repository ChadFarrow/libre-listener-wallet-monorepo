// Monotonic per-channel high-water marks of ChannelMonitor.get_latest_update_id(), used to
// detect channel-state regression on load. A node that reloads channel state BEHIND a point it
// durably reached must halt (not reconnect + get force-closed). Pure: no LDK, no storage.

export type Highwater = Map<string, bigint>;

export interface MonitorSummary {
  channelId: string; // 32-byte channel id, hex
  latestUpdateId: bigint; // ChannelMonitor.get_latest_update_id()
}

export interface Regression {
  channelId: string;
  loaded: bigint;
  highwater: bigint;
}

/** Parse the persisted marker. A corrupt/absent marker degrades to empty — NEVER throws, so a
 *  non-critical, re-derivable marker can't block startup. */
export function parseHighwater(raw: string | null): Highwater {
  const map: Highwater = new Map();
  if (!raw) return map;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return new Map();
  }
  // JSON.parse succeeds on valid-JSON non-objects (e.g. "null", "42"); those aren't a marker.
  if (typeof obj !== "object" || obj === null) return new Map();
  for (const [k, v] of Object.entries(obj as Record<string, string>)) {
    try {
      map.set(k, BigInt(v));
    } catch {
      // skip a single malformed entry; keep the rest
    }
  }
  return map;
}

export function serializeHighwater(map: Highwater): string {
  const obj: Record<string, string> = {};
  for (const [k, v] of map) obj[k] = v.toString();
  return JSON.stringify(obj);
}

/** Monotonic merge: each channel's mark only ever increases; new channels are added. Pure. */
export function mergeHighwater(stored: Highwater, summaries: MonitorSummary[]): Highwater {
  const next: Highwater = new Map(stored);
  for (const s of summaries) {
    const cur = next.get(s.channelId);
    if (cur === undefined || s.latestUpdateId > cur) next.set(s.channelId, s.latestUpdateId);
  }
  return next;
}

/** A regression is a LOADED monitor whose update id is below its recorded high-water. A high-water
 *  entry with no loaded monitor is NOT a regression (a legitimately-closed channel), avoiding a
 *  false halt. */
export function findRegression(summaries: MonitorSummary[], stored: Highwater): Regression | null {
  for (const s of summaries) {
    const hw = stored.get(s.channelId);
    if (hw !== undefined && s.latestUpdateId < hw) {
      return { channelId: s.channelId, loaded: s.latestUpdateId, highwater: hw };
    }
  }
  return null;
}

export function highwaterEquals(a: Highwater, b: Highwater): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export class ChannelStateRegressionError extends Error {
  readonly channelId: string;
  readonly loadedUpdateId: bigint;
  readonly highwaterUpdateId: bigint;
  constructor(r: Regression) {
    super(
      `Channel state regressed: channel ${r.channelId} loaded at monitor update ${r.loaded}, ` +
        `but this wallet durably reached ${r.highwater}. Refusing to start to avoid force-closing ` +
        `the channel — restore from a backup.`,
    );
    this.name = "ChannelStateRegressionError";
    this.channelId = r.channelId;
    this.loadedUpdateId = r.loaded;
    this.highwaterUpdateId = r.highwater;
  }
}
