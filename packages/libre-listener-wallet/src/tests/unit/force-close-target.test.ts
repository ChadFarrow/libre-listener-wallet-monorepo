import { describe, it, expect } from "vitest";
import { resolveForceCloseTarget, type ForceCloseCandidate } from "../../force-close";

// Force-close is unilateral and irreversible: it broadcasts our latest commitment and
// the channel is gone. Everything resolvable BEFORE touching LDK is resolved here, so a
// stale UI row or a typo fails as a plain error instead of reaching the channel manager.

const CHAN_A = "aa".repeat(32);
const CHAN_B = "bb".repeat(32);
const PEER_A = "02" + "11".repeat(32);
const PEER_B = "03" + "22".repeat(32);

const channel = (over: Partial<ForceCloseCandidate> = {}): ForceCloseCandidate => ({
  channelId: CHAN_A,
  counterpartyNodeId: PEER_A,
  isUsable: true,
  ...over,
});

describe("resolveForceCloseTarget", () => {
  it("resolves a known channel and echoes back the counterparty from live state", () => {
    const res = resolveForceCloseTarget([channel()], CHAN_A);
    expect(res).toEqual({ ok: true, channelId: CHAN_A, counterpartyNodeId: PEER_A });
  });

  it("resolves an offline channel — a peer being gone is the reason to force-close", () => {
    const res = resolveForceCloseTarget([channel({ isUsable: false })], CHAN_A);
    expect(res.ok).toBe(true);
  });

  it("refuses an unknown channel id rather than letting LDK reject it", () => {
    const res = resolveForceCloseTarget([channel()], CHAN_B);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no channel/i);
  });

  it("refuses an empty channel id", () => {
    const res = resolveForceCloseTarget([channel()], "");
    expect(res.ok).toBe(false);
  });

  it("refuses a non-hex or wrong-length channel id", () => {
    expect(resolveForceCloseTarget([channel()], "nothex").ok).toBe(false);
    expect(resolveForceCloseTarget([channel()], "aabb").ok).toBe(false);
  });

  // The caller passes the counterparty it displayed. If live state disagrees, the row the
  // user tapped is stale — close the wrong channel and the funds are just as gone.
  it("refuses when the caller's expected counterparty disagrees with live state", () => {
    const res = resolveForceCloseTarget([channel()], CHAN_A, PEER_B);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/counterparty/i);
  });

  it("accepts a matching expected counterparty", () => {
    const res = resolveForceCloseTarget([channel()], CHAN_A, PEER_A);
    expect(res.ok).toBe(true);
  });

  it("is case-insensitive about hex the UI may have upper-cased", () => {
    const res = resolveForceCloseTarget([channel()], CHAN_A.toUpperCase(), PEER_A.toUpperCase());
    expect(res).toEqual({ ok: true, channelId: CHAN_A, counterpartyNodeId: PEER_A });
  });

  it("refuses when no channels exist at all", () => {
    const res = resolveForceCloseTarget([], CHAN_A);
    expect(res.ok).toBe(false);
  });

  // Defensive: LDK should never list one channel id twice, but if it did, picking one
  // arbitrarily would be a coin flip over which channel gets destroyed.
  it("refuses an ambiguous duplicate channel id", () => {
    const dupes = [channel(), channel({ counterpartyNodeId: PEER_B })];
    const res = resolveForceCloseTarget(dupes, CHAN_A);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/ambiguous/i);
  });
});
