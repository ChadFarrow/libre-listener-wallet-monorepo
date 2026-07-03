import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LibreNWCPushGateway, isSafeRelayUrl } from "../../index";

describe("LibreNWCPushGateway Daemon & API", () => {
  let gateway: LibreNWCPushGateway;
  const PORT = 3099;

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

  it("should register a subscription successfully and persist in SQLite", async () => {
    const registrationPayload = {
      walletPubkey: "02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      relayUrl: "ws://127.0.0.1:4869",
      subscription: {
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA...",
        keys: {
          auth: "authsecret123",
          p256dh: "p256dhkey123"
        }
      }
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
    const pubkeys = gateway.getRegisteredPubkeys("ws://127.0.0.1:4869");
    expect(pubkeys).toContain(registrationPayload.walletPubkey);
  });

  it("should unregister a subscription successfully", async () => {
    const unregisterPayload = {
      walletPubkey: "02abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      relayUrl: "ws://127.0.0.1:4869"
    };

    const res = await fetch(`http://127.0.0.1:${PORT}/api/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(unregisterPayload)
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    const pubkeys = gateway.getRegisteredPubkeys("ws://127.0.0.1:4869");
    expect(pubkeys).not.toContain(unregisterPayload.walletPubkey);
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
});
