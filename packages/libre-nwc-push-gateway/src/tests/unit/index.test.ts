import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LibreNWCPushGateway, isSafeRelayUrl, verifyGatewayAuth } from "../../index";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";

// Sign a NIP-98-style gateway auth (matches SDK NwcManager.buildGatewayAuth) so tests exercise the
// REAL authenticated register/unregister flow rather than disabling auth.
function buildAuth(
  sk: Uint8Array,
  action: "register" | "unregister",
  relayUrl: string,
  opts: { endpoint?: string; createdAt?: number } = {}
) {
  const tags: string[][] = [["action", action], ["relay", relayUrl]];
  if (opts.endpoint) tags.push(["endpoint", opts.endpoint]);
  return finalizeEvent(
    {
      kind: 27235,
      created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
      tags,
      content: "libre-push-auth",
    },
    sk
  );
}

describe("LibreNWCPushGateway Daemon & API", () => {
  let gateway: LibreNWCPushGateway;
  const PORT = 3099;
  // A real keypair so the core register/unregister tests can sign a valid auth.
  const clientSk = generateSecretKey();
  const clientPubkey = getPublicKey(clientSk);

  beforeAll(async () => {
    gateway = new LibreNWCPushGateway({
      host: "127.0.0.1",
      port: PORT,
      dbPath: ":memory:", // use in-memory DB for isolated unit tests
      allowPrivateRelays: true, // loopback relay used for test isolation
    });
    await gateway.start();
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("should start running and expose the VAPID public key", async () => {
    expect(gateway.status()).toBe("Running");

    const res = await fetch(`http://127.0.0.1:${PORT}/api/vapid-public-key`);
    expect(res.status).toBe(200);
    
    const body = await res.json() as { publicKey: string };
    expect(body.publicKey).toBeDefined();
    expect(typeof body.publicKey).toBe("string");
    expect(body.publicKey.length).toBeGreaterThan(20);
  });

  const RELAY = "ws://127.0.0.1:4869";
  const ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA...";

  it("should register a subscription successfully (signed) and persist in SQLite", async () => {
    const registrationPayload = {
      walletPubkey: clientPubkey,
      relayUrl: RELAY,
      subscription: { endpoint: ENDPOINT, keys: { auth: "authsecret123", p256dh: "p256dhkey123" } },
      auth: buildAuth(clientSk, "register", RELAY, { endpoint: ENDPOINT }),
    };

    const res = await fetch(`http://127.0.0.1:${PORT}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registrationPayload)
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    // Verify it is saved in the DB
    const pubkeys = gateway.getRegisteredPubkeys(RELAY);
    expect(pubkeys).toContain(clientPubkey);
  });

  it("rejects registration with no / invalid / stale / mis-bound auth (401)", async () => {
    const sub = { endpoint: ENDPOINT, keys: { auth: "a", p256dh: "p" } };
    const post = (auth: unknown) =>
      fetch(`http://127.0.0.1:${PORT}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletPubkey: clientPubkey, relayUrl: RELAY, subscription: sub, auth }),
      });

    // No auth at all.
    expect((await post(undefined)).status).toBe(401);
    // Signed by a DIFFERENT key (impersonation attempt) — pubkey won't match.
    expect((await post(buildAuth(generateSecretKey(), "register", RELAY, { endpoint: ENDPOINT }))).status).toBe(401);
    // Stale (older than the freshness window).
    expect((await post(buildAuth(clientSk, "register", RELAY, { endpoint: ENDPOINT, createdAt: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
    // Wrong action (an unregister auth can't authorize a register).
    expect((await post(buildAuth(clientSk, "unregister", RELAY, { endpoint: ENDPOINT }))).status).toBe(401);
    // Endpoint tampering: auth signed for a DIFFERENT endpoint than the body's subscription.
    expect((await post(buildAuth(clientSk, "register", RELAY, { endpoint: "https://evil.example/x" }))).status).toBe(401);
  });

  it("should unregister a subscription successfully (signed)", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletPubkey: clientPubkey, relayUrl: RELAY, auth: buildAuth(clientSk, "unregister", RELAY) })
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    const pubkeys = gateway.getRegisteredPubkeys(RELAY);
    expect(pubkeys).not.toContain(clientPubkey);
  });

  it("rejects unregister with no auth (401) — can't delete a stranger's subscription", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletPubkey: clientPubkey, relayUrl: RELAY }),
    });
    expect(res.status).toBe(401);
  });

  it("verifyGatewayAuth is a pure boundary check (unit)", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const now = 1_800_000_000;
    const ev = buildAuth(sk, "register", RELAY, { endpoint: ENDPOINT, createdAt: now });
    expect(verifyGatewayAuth(ev, pk, "register", RELAY, { endpoint: ENDPOINT, now })).toBe(true);
    expect(verifyGatewayAuth(ev, pk, "register", RELAY, { endpoint: "other", now })).toBe(false);
    expect(verifyGatewayAuth(ev, pk, "unregister", RELAY, { now })).toBe(false);
    expect(verifyGatewayAuth(ev, "deadbeef", "register", RELAY, { endpoint: ENDPOINT, now })).toBe(false);
    expect(verifyGatewayAuth(ev, pk, "register", RELAY, { endpoint: ENDPOINT, now: now + 10_000 })).toBe(false);
    expect(verifyGatewayAuth(null, pk, "register", RELAY, { endpoint: ENDPOINT, now })).toBe(false);
  });

  it("rejects an SSRF/private relayUrl on registration (default-safe gateway)", async () => {
    const SAFE_PORT = 3097;
    const g = new LibreNWCPushGateway({ host: "127.0.0.1", port: SAFE_PORT, dbPath: ":memory:" });
    await g.start();
    try {
      const res = await fetch(`http://127.0.0.1:${SAFE_PORT}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPubkey: "02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890".slice(0, 64),
          relayUrl: "ws://169.254.169.254:80", // cloud-metadata SSRF probe
          subscription: {
            endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x",
            keys: { auth: "a", p256dh: "p" },
          },
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await g.stop();
    }
  });

  it("isSafeRelayUrl blocks private/plaintext, allows public wss", () => {
    expect(isSafeRelayUrl("wss://relay.getalby.com/v1")).toBe(true);
    expect(isSafeRelayUrl("ws://relay.getalby.com")).toBe(false); // no TLS
    expect(isSafeRelayUrl("wss://169.254.169.254")).toBe(false); // link-local
    expect(isSafeRelayUrl("wss://127.0.0.1")).toBe(false); // loopback
    expect(isSafeRelayUrl("wss://10.0.0.5")).toBe(false); // private
    expect(isSafeRelayUrl("https://evil.com")).toBe(false); // wrong scheme
    expect(isSafeRelayUrl("ws://127.0.0.1", true)).toBe(true); // override for tests
  });

  it("isSafeRelayUrl blocks IPv4-mapped IPv6 and IPv6 private/loopback literals (SSRF)", () => {
    // ::ffff:127.0.0.1 — URL normalizes the dotted form to the hex form, both must be caught
    expect(isSafeRelayUrl("wss://[::ffff:127.0.0.1]")).toBe(false);
    expect(isSafeRelayUrl("wss://[::ffff:7f00:1]")).toBe(false); // hex form of 127.0.0.1
    expect(isSafeRelayUrl("wss://[::1]")).toBe(false); // IPv6 loopback
    expect(isSafeRelayUrl("wss://[fd00::1]")).toBe(false); // IPv6 unique-local
    expect(isSafeRelayUrl("wss://[fe80::1]")).toBe(false); // IPv6 link-local
    // A normal public host still passes.
    expect(isSafeRelayUrl("wss://relay.damus.io")).toBe(true);
  });

  it("rejects registration once the subscription-row cap is exceeded (429)", async () => {
    const CAP_PORT = 3096;
    const g = new LibreNWCPushGateway({
      host: "127.0.0.1",
      port: CAP_PORT,
      dbPath: ":memory:",
      allowPrivateRelays: true,
      maxSubscriptions: 2,
      requirePushAuth: false, // this test targets the row-cap, not auth
    });
    await g.start();
    try {
      const relayUrl = "ws://127.0.0.1:4870";
      const sub = {
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x",
        keys: { auth: "a", p256dh: "p" },
      };
      const register = (pubkey: string) =>
        fetch(`http://127.0.0.1:${CAP_PORT}/api/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletPubkey: pubkey, relayUrl, subscription: sub }),
        });

      const r1 = await register("aa".repeat(32));
      const r2 = await register("bb".repeat(32));
      const r3 = await register("cc".repeat(32));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(429); // cap of 2 reached
    } finally {
      await g.stop();
    }
  });

  it("rejects a registration with an absurdly long endpoint (400)", async () => {
    const LEN_PORT = 3095;
    const g = new LibreNWCPushGateway({
      host: "127.0.0.1",
      port: LEN_PORT,
      dbPath: ":memory:",
      allowPrivateRelays: true,
    });
    await g.start();
    try {
      const res = await fetch(`http://127.0.0.1:${LEN_PORT}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPubkey: "aa".repeat(32),
          relayUrl: "ws://127.0.0.1:4871",
          subscription: {
            endpoint: "https://updates.push.services.mozilla.com/wpush/v2/" + "a".repeat(6000),
            keys: { auth: "a", p256dh: "p" },
          },
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await g.stop();
    }
  });

  it("returns a generic error (no internal exception text) on a 500", async () => {
    const ERR_PORT = 3094;
    const g = new LibreNWCPushGateway({
      host: "127.0.0.1",
      port: ERR_PORT,
      dbPath: ":memory:",
      allowPrivateRelays: true,
      requirePushAuth: false, // this test targets the 500 path, not auth
    });
    await g.start();
    try {
      // Force the INSERT to throw with a message that must NOT leak to the client.
      (g as any).db = {
        prepare: () => {
          throw new Error("SUPER-SECRET-INTERNAL-DETAIL");
        },
      };
      const res = await fetch(`http://127.0.0.1:${ERR_PORT}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletPubkey: "aa".repeat(32),
          relayUrl: "wss://relay.damus.io",
          subscription: {
            endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x",
            keys: { auth: "a", p256dh: "p" },
          },
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("internal error");
      expect(body.error).not.toContain("SECRET");
    } finally {
      // db is a stub now; stop() would call db.close() — restore a no-op close.
      (g as any).db = { close: () => {} };
      await g.stop();
    }
  });
});
