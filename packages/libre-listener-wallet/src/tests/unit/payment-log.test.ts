import { describe, it, expect } from "vitest";
import { PaymentLogger, boostNoteFromCustomRecords, TX_KEY_PREFIX } from "../../payment-log";
import type { SecureStorageProvider } from "../../index";

// Minimal in-memory listable provider (implements the optional keys()).
class MemStorage implements SecureStorageProvider {
  store = new Map<string, string>();
  async getItem(k: string): Promise<string | null> {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  async setItem(k: string, v: string): Promise<void> {
    this.store.set(k, v);
  }
  async removeItem(k: string): Promise<void> {
    this.store.delete(k);
  }
  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }
}

// Let the fire-and-forget persists (void setItem().catch()) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PaymentLogger", () => {
  it("notePending writes a pending tx_<hash> record", async () => {
    const s = new MemStorage();
    const log = new PaymentLogger({ storage: s });
    log.notePending({ id: "h1", direction: "sent", status: "pending", amountSats: 1000, timestamp: 1 });
    await flush();
    expect(s.store.has(`${TX_KEY_PREFIX}h1`)).toBe(true);
    const [rec] = log.getRecords();
    expect(rec).toMatchObject({ id: "h1", direction: "sent", status: "pending", amountSats: 1000 });
  });

  it("recordSent finalizes the matching pending record (same key upserted)", async () => {
    const s = new MemStorage();
    const log = new PaymentLogger({ storage: s });
    log.notePending({ id: "h1", direction: "sent", status: "pending", amountSats: 1000, timestamp: 1 });
    log.recordSent("h1", 2, "preimagehex");
    await flush();
    const [rec] = log.getRecords();
    expect(rec.status).toBe("settled");
    expect(rec.amountSats).toBe(1000); // preserved from the intent
    expect(rec.feeSats).toBe(2);
    expect(rec.preimage).toBe("preimagehex");
    expect(rec.settledAt).toBeGreaterThan(0);
    // still one key (upsert, not a second record)
    expect([...s.store.keys()].filter((k) => k.startsWith(TX_KEY_PREFIX))).toHaveLength(1);
  });

  it("recordSent with no pending writes a minimal settled sent (amount unknown)", async () => {
    const s = new MemStorage();
    const log = new PaymentLogger({ storage: s });
    log.recordSent("orphan", 5);
    await flush();
    const [rec] = log.getRecords();
    expect(rec).toMatchObject({ id: "orphan", direction: "sent", status: "settled", amountSats: 0, feeSats: 5 });
  });

  it("recordFailed marks a pending record failed", async () => {
    const log = new PaymentLogger({ storage: new MemStorage() });
    log.notePending({ id: "h1", direction: "sent", status: "pending", amountSats: 1000, timestamp: 1 });
    log.recordFailed("h1");
    expect(log.getRecords()[0].status).toBe("failed");
  });

  it("recordReceived writes a settled inbound record", async () => {
    const log = new PaymentLogger({ storage: new MemStorage() });
    log.recordReceived("in1", 4200);
    const [rec] = log.getRecords();
    expect(rec).toMatchObject({ id: "in1", direction: "received", status: "settled", amountSats: 4200 });
    expect(rec.settledAt).toBeGreaterThan(0);
  });

  it("getRecords returns newest-first", () => {
    const log = new PaymentLogger({ storage: new MemStorage() });
    log.notePending({ id: "a", direction: "sent", status: "pending", amountSats: 1, timestamp: 100 });
    log.notePending({ id: "b", direction: "sent", status: "pending", amountSats: 1, timestamp: 300 });
    log.notePending({ id: "c", direction: "sent", status: "pending", amountSats: 1, timestamp: 200 });
    expect(log.getRecords().map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("load() rehydrates all tx_* keys into memory", async () => {
    const s = new MemStorage();
    const log1 = new PaymentLogger({ storage: s });
    log1.notePending({ id: "h1", direction: "sent", status: "pending", amountSats: 10, timestamp: 1 });
    log1.recordReceived("h2", 20);
    await flush();

    const log2 = new PaymentLogger({ storage: s });
    await log2.load();
    const ids = log2.getRecords().map((r) => r.id).sort();
    expect(ids).toEqual(["h1", "h2"]);
  });

  it("load() degrades gracefully when the provider has no keys()", async () => {
    const noKeys: SecureStorageProvider = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    };
    const log = new PaymentLogger({ storage: noKeys });
    await log.load(); // must not throw
    expect(log.getRecords()).toEqual([]);
  });

  it("notePending does not clobber an already-settled record", () => {
    const log = new PaymentLogger({ storage: new MemStorage() });
    log.notePending({ id: "h1", direction: "sent", status: "pending", amountSats: 1000, timestamp: 1 });
    log.recordSent("h1", 1);
    log.notePending({ id: "h1", direction: "sent", status: "pending", amountSats: 1000, timestamp: 1 });
    expect(log.getRecords()[0].status).toBe("settled");
  });
});

describe("boostNoteFromCustomRecords", () => {
  const boostJson = (obj: Record<string, unknown>) => JSON.stringify(obj);

  it("returns podcast · episode when both present", () => {
    const note = boostNoteFromCustomRecords({ 7629169: boostJson({ podcast: "My Show", episode: "Ep 3" }) });
    expect(note).toBe("My Show · Ep 3");
  });

  it("falls back to message then name", () => {
    expect(boostNoteFromCustomRecords({ 7629169: boostJson({ message: "great ep!" }) })).toBe("great ep!");
    expect(boostNoteFromCustomRecords({ 7629169: boostJson({ name: "Alice" }) })).toBe("Alice");
  });

  it("decodes a Uint8Array TLV value", () => {
    const bytes = new TextEncoder().encode(boostJson({ podcast: "Bytes FM" }));
    expect(boostNoteFromCustomRecords({ 7629169: bytes })).toBe("Bytes FM");
  });

  it("tolerates missing key and malformed JSON", () => {
    expect(boostNoteFromCustomRecords(undefined)).toBeUndefined();
    expect(boostNoteFromCustomRecords({})).toBeUndefined();
    expect(boostNoteFromCustomRecords({ 7629169: "{not json" })).toBeUndefined();
  });
});
