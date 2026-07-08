import webpush from "web-push";
import Database from "better-sqlite3";
import { Relay, verifyEvent } from "nostr-tools";
import {
  GATEWAY_AUTH_KIND,
  GATEWAY_AUTH_MAX_AGE_SEC,
  verifyGatewayAuth as verifyGatewayAuthShared,
  type GatewayAuthAction,
} from "@libre/shared";

// NIP-98-style push-auth. The wire contract (kind, tag names, freshness window) lives in
// @libre/shared gateway-auth.ts — the SAME module the SDK's buildGatewayAuth signs against —
// so the signer and this verifier cannot drift. Re-exported for the existing consumers/tests.
export { GATEWAY_AUTH_KIND, GATEWAY_AUTH_MAX_AGE_SEC };

/** Shared verifier bound to nostr-tools' signature check. See @libre/shared gateway-auth.ts. */
export function verifyGatewayAuth(
  auth: unknown,
  walletPubkey: string,
  action: GatewayAuthAction,
  relayUrl: string,
  opts: { endpoint?: string; now?: number; maxAgeSec?: number } = {},
): boolean {
  return verifyGatewayAuthShared(auth, walletPubkey, action, relayUrl, (ev) => verifyEvent(ev), opts);
}

export interface GatewayConfig {
  host?: string;
  port: number;
  relayUrl?: string;
  dbPath?: string;
  /**
   * Allow ws:// and private/loopback/link-local relay hosts. Defaults to false:
   * the public gateway must not be coaxed into opening outbound connections to
   * internal services (SSRF). Enable only for local/regtest testing.
   */
  allowPrivateRelays?: boolean;
  /** Hard cap on distinct relay listeners, to bound memory/FD growth. */
  maxRelayListeners?: number;
  /**
   * Hard cap on total subscription rows, to bound DB growth against a flood of
   * random pubkeys. New rows past the cap are refused; updates to existing rows
   * are always allowed.
   */
  maxSubscriptions?: number;
  /**
   * Require a valid NIP-98-style signature (proving control of walletPubkey) on register/unregister.
   * Defaults to TRUE — it's the control that stops a stranger from hijacking/deleting a victim's push
   * subscription. Set false ONLY in tests / trusted single-tenant setups.
   */
  requirePushAuth?: boolean;
}

const DEFAULT_MAX_RELAY_LISTENERS = 64;
const DEFAULT_MAX_SUBSCRIPTIONS = 50_000;

// Absurd-length guards on attacker-controlled subscription fields (bytes/chars).
// A real Web Push endpoint is well under 512 chars; keys are short base64url blobs.
const MAX_ENDPOINT_LEN = 2048;
const MAX_KEY_LEN = 512;

// RGS passthrough hardening: bound upstream fetch time, response size, and re-fetch
// churn (a small TTL cache keyed by the validated timestamp).
const RGS_FETCH_TIMEOUT_MS = 15_000;
const RGS_MAX_BYTES = 32 * 1024 * 1024; // 32 MB
const RGS_CACHE_TTL_MS = 60_000;
const RGS_MAX_CACHE_ENTRIES = 8;

// A non-OK / oversized upstream RGS response, carrying the HTTP status the proxy should relay
// (an empty message means "status only, no JSON error body" — matching a passthrough of the
// upstream status).
class RgsUpstreamError extends Error {
  constructor(readonly status: number, message = "") {
    super(message);
    this.name = "RgsUpstreamError";
  }
}

/** True for a private / loopback / link-local / reserved IPv4 literal. */
function isPrivateIpv4(ip: string): boolean {
  if (ip === "0.0.0.0") return true;
  if (ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("169.254.")) return true;
  if (ip.startsWith("192.168.")) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

// If `h` is an IPv4-mapped IPv6 address (::ffff:a.b.c.d dotted, or its ::ffff:HHHH:HHHH
// hex form — note new URL() normalizes the dotted form to hex), return the embedded
// IPv4 so its privateness can be re-checked; otherwise null. This closes the SSRF hole
// where `wss://[::ffff:127.0.0.1]` normalizes to `[::ffff:7f00:1]` and slips past a
// naive string match to reach loopback.
function mappedIpv4(h: string): string | null {
  const dotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

// Private / loopback / link-local / reserved IPv4 literals + IPv6 loopback/ULA/link-local
// and IPv4-mapped IPv6. Blocking these prevents an attacker-supplied relayUrl from making
// the server probe internal services (e.g. cloud metadata at 169.254.169.254).
// NOTE: kept in sync BY HAND with ws-bridge/src/allowlist.ts (that package can't import
// @libre/shared — Railway builds it with Root Directory=ws-bridge, where workspace packages
// don't resolve). Harden both together.
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "::") return true;
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 / ::ffff:7f00:1) — judge by the embedded IPv4.
  const mapped = mappedIpv4(h);
  if (mapped) return isPrivateIpv4(mapped);
  if (isPrivateIpv4(h)) return true;
  // IPv6 unique-local (fc00::/7 → hex starts fc/fd) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:")) return true;
  return false;
}

/** A Nostr relay URL is acceptable to connect to (SSRF-safe unless overridden). */
export function isSafeRelayUrl(raw: string, allowPrivate = false): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (allowPrivate) return u.protocol === "ws:" || u.protocol === "wss:";
  if (u.protocol !== "wss:") return false; // public: require TLS
  if (!u.hostname || isPrivateHost(u.hostname)) return false;
  return true;
}

/** A Web Push endpoint must be an HTTPS URL to a non-private host. */
function isSafePushEndpoint(raw: string, allowPrivate = false): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (!allowPrivate && (!u.hostname || isPrivateHost(u.hostname))) return false;
  return true;
}

class NostrRelayListener {
  private relayUrl: string;
  private gateway: LibreNWCPushGateway;
  private relay: Relay | null = null;
  private sub: any = null;
  private isConnected: boolean = false;
  private reconnectTimeout: any = null;

  constructor(relayUrl: string, gateway: LibreNWCPushGateway) {
    this.relayUrl = relayUrl;
    this.gateway = gateway;
  }

  async connect() {
    if (this.isConnected) return;
    try {
      console.log(`[NostrListener] Connecting to relay: ${this.relayUrl}`);
      this.relay = await Relay.connect(this.relayUrl);
      this.isConnected = true;
      this.subscribe();
    } catch (e: any) {
      console.error(`[NostrListener] Connection failed to ${this.relayUrl}:`, e.message || e);
      this.scheduleReconnect();
    }
  }

  private subscribe() {
    if (!this.relay) return;

    const pubkeys = this.gateway.getRegisteredPubkeys(this.relayUrl);
    if (pubkeys.length === 0) {
      console.log(`[NostrListener] No pubkeys registered for ${this.relayUrl}, skipping subscription`);
      return;
    }

    console.log(`[NostrListener] Subscribing on ${this.relayUrl} for pubkeys:`, pubkeys);

    this.sub = this.relay.subscribe([
      {
        kinds: [23194],
        "#p": pubkeys
      }
    ], {
      onevent: async (event) => {
        console.log(`[NostrListener] Received NWC request event on ${this.relayUrl}`);
        await this.gateway.handleNwcEvent(event, this.relayUrl);
      },
      onclose: (reason) => {
        console.warn(`[NostrListener] Subscription closed on ${this.relayUrl}:`, reason);
        this.isConnected = false;
        this.scheduleReconnect();
      }
    });
  }

  updateSubscription() {
    if (this.sub) {
      this.sub.close();
      this.sub = null;
    }
    if (this.isConnected) {
      this.subscribe();
    } else {
      // connect() handles its own errors (try/catch → scheduleReconnect), so it
      // never rejects; void marks the fire-and-forget intentional.
      void this.connect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.connect();
    }, 5000);
  }

  close() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.sub) {
      try { this.sub.close(); } catch (e) {}
      this.sub = null;
    }
    if (this.relay) {
      try { this.relay.close(); } catch (e) {}
      this.relay = null;
    }
    this.isConnected = false;
  }
}

export class LibreNWCPushGateway {
  private config: GatewayConfig;
  private isRunning: boolean = false;
  private db: any = null;
  private vapidPublicKey: string = "";
  private listeners: Map<string, NostrRelayListener> = new Map();
  private server: any = null;
  // In-memory TTL cache for RGS snapshots, keyed by validated timestamp. Holds the in-flight
  // fetch promise (not the finished body) so concurrent misses coalesce onto one upstream request.
  private rgsCache: Map<string, { body: Promise<Buffer>; expires: number }> = new Map();

  /** Fetch one upstream RGS snapshot, bounded in time and size. Throws RgsUpstreamError. */
  private async fetchRgsSnapshot(ts: string): Promise<Buffer> {
    const upstream = await fetch(`https://rapidsync.lightningdevkit.org/snapshot/${ts}`, {
      signal: AbortSignal.timeout(RGS_FETCH_TIMEOUT_MS),
    });
    if (!upstream.ok) throw new RgsUpstreamError(upstream.status);
    // Reject an oversized body (before and after download) to bound memory.
    const declared = Number(upstream.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > RGS_MAX_BYTES) {
      console.warn(`[RGS] upstream snapshot too large (content-length ${declared})`);
      throw new RgsUpstreamError(502, "rgs snapshot too large");
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > RGS_MAX_BYTES) {
      console.warn(`[RGS] upstream snapshot too large (${buf.length} bytes)`);
      throw new RgsUpstreamError(502, "rgs snapshot too large");
    }
    return buf;
  }

  constructor(config: GatewayConfig) {
    this.config = {
      host: config.host || "127.0.0.1",
      port: config.port,
      relayUrl: config.relayUrl,
      dbPath: config.dbPath,
      allowPrivateRelays: config.allowPrivateRelays ?? false,
      maxRelayListeners: config.maxRelayListeners ?? DEFAULT_MAX_RELAY_LISTENERS,
      maxSubscriptions: config.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS,
      requirePushAuth: config.requirePushAuth ?? true,
    };
  }

  getRegisteredPubkeys(relayUrl: string): string[] {
    if (!this.db) return [];
    const rows = this.db.prepare("SELECT DISTINCT wallet_pubkey FROM subscriptions WHERE relay_url = ?").all(relayUrl) as { wallet_pubkey: string }[];
    return rows.map(r => r.wallet_pubkey);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.db = new Database(this.config.dbPath || "push-gateway.db");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vapid_keys (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        wallet_pubkey TEXT NOT NULL,
        relay_url TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (wallet_pubkey, relay_url)
      );
    `);

    let vapidKeys = this.db.prepare("SELECT public_key, private_key FROM vapid_keys WHERE id = 1").get() as { public_key: string; private_key: string } | undefined;
    if (!vapidKeys) {
      const keys = webpush.generateVAPIDKeys();
      this.db.prepare("INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)").run(keys.publicKey, keys.privateKey);
      vapidKeys = { public_key: keys.publicKey, private_key: keys.privateKey };
    }
    this.vapidPublicKey = vapidKeys.public_key;

    webpush.setVapidDetails(
      "mailto:contact@v4vmusic.com",
      vapidKeys.public_key,
      vapidKeys.private_key
    );

    const express = (await import("express")).default;
    const cors = (await import("cors")).default;
    const app = express();

    app.use(cors());
    app.use(express.json());

    app.get("/api/vapid-public-key", (req, res) => {
      res.json({ publicKey: this.vapidPublicKey });
    });

    app.post("/api/register", async (req, res) => {
      try {
        const { walletPubkey, relayUrl, subscription } = req.body;
        if (!walletPubkey || !relayUrl || !subscription) {
          res.status(400).json({ error: "Missing required parameters" });
          return;
        }
        if (typeof walletPubkey !== "string" || !/^[0-9a-f]{64,66}$/i.test(walletPubkey)) {
          res.status(400).json({ error: "walletPubkey must be a hex-encoded key" });
          return;
        }
        if (typeof relayUrl !== "string" || !isSafeRelayUrl(relayUrl, this.config.allowPrivateRelays)) {
          res.status(400).json({ error: "relayUrl must be a wss:// URL to a public host" });
          return;
        }
        if (
          !subscription.endpoint ||
          !subscription.keys?.p256dh ||
          !subscription.keys?.auth ||
          !isSafePushEndpoint(subscription.endpoint, this.config.allowPrivateRelays)
        ) {
          res.status(400).json({ error: "subscription must have an https endpoint and keys" });
          return;
        }
        // Reject absurdly long attacker-controlled fields (memory/DB abuse).
        if (
          typeof subscription.endpoint !== "string" ||
          subscription.endpoint.length > MAX_ENDPOINT_LEN ||
          typeof subscription.keys.p256dh !== "string" ||
          subscription.keys.p256dh.length > MAX_KEY_LEN ||
          typeof subscription.keys.auth !== "string" ||
          subscription.keys.auth.length > MAX_KEY_LEN
        ) {
          res.status(400).json({ error: "subscription field exceeds maximum length" });
          return;
        }
        // Prove control of walletPubkey (a public value) before mutating its subscription — else a
        // stranger could overwrite a victim's push endpoint with their own. The signature is bound
        // to this exact endpoint, so a captured auth can't be paired with a different subscription.
        if (
          this.config.requirePushAuth &&
          !verifyGatewayAuth(req.body.auth, walletPubkey, "register", relayUrl, { endpoint: subscription.endpoint })
        ) {
          res.status(401).json({ error: "missing or invalid auth signature" });
          return;
        }
        // Bound the number of distinct relays we will ever connect to.
        if (
          !this.listeners.has(relayUrl) &&
          this.listeners.size >= (this.config.maxRelayListeners ?? DEFAULT_MAX_RELAY_LISTENERS)
        ) {
          res.status(429).json({ error: "relay listener capacity reached" });
          return;
        }
        // Bound total subscription rows against a flood of random pubkeys. Updates to
        // an existing (wallet_pubkey, relay_url) row are always allowed; only genuinely
        // new rows are capped.
        const maxSubs = this.config.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
        const exists = this.db
          .prepare("SELECT 1 FROM subscriptions WHERE wallet_pubkey = ? AND relay_url = ?")
          .get(walletPubkey, relayUrl);
        if (!exists) {
          const { c } = this.db.prepare("SELECT COUNT(*) AS c FROM subscriptions").get() as { c: number };
          if (c >= maxSubs) {
            res.status(429).json({ error: "subscription capacity reached" });
            return;
          }
        }

        this.db.prepare(`
          INSERT OR REPLACE INTO subscriptions (wallet_pubkey, relay_url, endpoint, p256dh, auth, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          walletPubkey,
          relayUrl,
          subscription.endpoint,
          subscription.keys.p256dh,
          subscription.keys.auth,
          Date.now()
        );

        console.log(`[Gateway] Registered subscription for wallet ${walletPubkey} on relay ${relayUrl}`);

        this.ensureRelayListener(relayUrl);

        res.json({ success: true });
      } catch (err: any) {
        // Log details server-side; never leak internal exception text to the client.
        console.error("Registration error:", err);
        res.status(500).json({ error: "internal error" });
      }
    });

    app.post("/api/unregister", (req, res) => {
      try {
        const { walletPubkey, relayUrl } = req.body;
        if (!walletPubkey || !relayUrl) {
          res.status(400).json({ error: "Missing parameters" });
          return;
        }
        // Require proof of control so a stranger can't delete a victim's subscription.
        if (
          this.config.requirePushAuth &&
          !verifyGatewayAuth(req.body.auth, walletPubkey, "unregister", relayUrl)
        ) {
          res.status(401).json({ error: "missing or invalid auth signature" });
          return;
        }

        this.db.prepare("DELETE FROM subscriptions WHERE wallet_pubkey = ? AND relay_url = ?")
          .run(walletPubkey, relayUrl);

        const listener = this.listeners.get(relayUrl);
        if (listener) {
          listener.updateSubscription();
        }

        res.json({ success: true });
      } catch (err: any) {
        // Log details server-side; never leak internal exception text to the client.
        console.error("Unregister error:", err);
        res.status(500).json({ error: "internal error" });
      }
    });

    // CORS-enabled passthrough for LDK Rapid Gossip Sync snapshots. A browser fetch
    // against rapidsync.lightningdevkit.org is CORS-blocked (no Access-Control-Allow-Origin),
    // so the wallet can't populate its network graph (⇒ no multi-hop routing). The SDK
    // requests `${rapidGossipSyncUrl}/${lastTimestamp}`, so this path takes :timestamp.
    app.get("/rgs/snapshot/:timestamp", async (req, res) => {
      const ts = req.params.timestamp;
      if (!/^\d+$/.test(ts)) {
        res.status(400).json({ error: "timestamp must be a non-negative integer" });
        return;
      }
      const now = Date.now();
      // Evict every expired entry up front — the TTL check alone left dead multi-MB Buffers
      // resident until the size cap happened to push them out.
      for (const [key, entry] of this.rgsCache) {
        if (entry.expires <= now) this.rgsCache.delete(key);
      }
      // Serve from cache. The cache holds the in-flight PROMISE (set before the fetch starts),
      // so an app-start burst of concurrent misses for one timestamp shares a single upstream
      // fetch instead of buffering up to 32MB per request; a rejected fetch is dropped from the
      // cache immediately so errors are never cached past the burst that shared them.
      let entry = this.rgsCache.get(ts);
      if (!entry) {
        const body = this.fetchRgsSnapshot(ts);
        entry = { body, expires: now + RGS_CACHE_TTL_MS };
        this.rgsCache.set(ts, entry);
        body.catch(() => {
          if (this.rgsCache.get(ts) === entry) this.rgsCache.delete(ts);
        });
        if (this.rgsCache.size > RGS_MAX_CACHE_ENTRIES) {
          const oldest = this.rgsCache.keys().next().value;
          if (oldest !== undefined) this.rgsCache.delete(oldest);
        }
      }
      try {
        res.set("Content-Type", "application/octet-stream").send(await entry.body);
      } catch (err: any) {
        if (err instanceof RgsUpstreamError) {
          if (err.message) res.status(err.status).json({ error: err.message });
          else res.status(err.status).end();
          return;
        }
        console.error("[RGS] proxy failed:", err.message || err);
        res.status(502).json({ error: "rgs upstream fetch failed" });
      }
    });

    this.server = app.listen(this.config.port, this.config.host || "127.0.0.1", () => {
      console.log(`[Gateway] HTTP server listening on ${this.config.host || "127.0.0.1"}:${this.config.port}`);
    });

    const relays = this.db.prepare("SELECT DISTINCT relay_url FROM subscriptions").all() as { relay_url: string }[];
    for (const r of relays) {
      this.ensureRelayListener(r.relay_url);
    }

    if (this.config.relayUrl) {
      this.ensureRelayListener(this.config.relayUrl);
    }

    this.isRunning = true;
  }

  private ensureRelayListener(relayUrl: string) {
    let listener = this.listeners.get(relayUrl);
    if (!listener) {
      // Defense-in-depth: never open an outbound connection to an unsafe or
      // over-cap relay, even if a stale/hostile row reached the DB some other way.
      if (!isSafeRelayUrl(relayUrl, this.config.allowPrivateRelays)) {
        console.warn(`[Gateway] Refusing unsafe relay URL: ${relayUrl}`);
        return;
      }
      if (this.listeners.size >= (this.config.maxRelayListeners ?? DEFAULT_MAX_RELAY_LISTENERS)) {
        console.warn(`[Gateway] Relay listener cap reached; not connecting ${relayUrl}`);
        return;
      }
      listener = new NostrRelayListener(relayUrl, this);
      this.listeners.set(relayUrl, listener);
      listener.connect().catch(err => {
        console.error(`[Gateway] Error initializing relay ${relayUrl}:`, err.message || err);
      });
    } else {
      listener.updateSubscription();
    }
  }

  async handleNwcEvent(event: any, relayUrl: string): Promise<void> {
    // The relay callback runs outside any Express handler, so an unguarded throw
    // here is an unhandled rejection. It can also fire mid-shutdown after stop()
    // nulls the DB — bail cleanly in that case.
    if (!this.db) return;
    const walletPubkey = Array.isArray(event?.tags)
      ? event.tags.find((t: string[]) => t[0] === "p")?.[1]
      : undefined;
    if (!walletPubkey) return;

    let rows: { endpoint: string; p256dh: string; auth: string }[];
    try {
      rows = this.db.prepare("SELECT endpoint, p256dh, auth FROM subscriptions WHERE wallet_pubkey = ? AND relay_url = ?")
        .all(walletPubkey, relayUrl) as { endpoint: string; p256dh: string; auth: string }[];
    } catch (err: any) {
      console.error("[Gateway] handleNwcEvent DB read failed:", err?.message || err);
      return;
    }

    for (const row of rows) {
      const pushSubscription = {
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth
        }
      };

      const payload = JSON.stringify({
        walletPubkey,
        relayUrl,
        eventId: event.id
      });

      try {
        await webpush.sendNotification(pushSubscription, payload);
        console.log(`[Gateway] Successfully sent push notification for wallet ${walletPubkey} on relay ${relayUrl}`);
      } catch (err: any) {
        console.error(`[Gateway] Failed to send push notification:`, err.message || err);
        if (err.statusCode === 410 || err.statusCode === 404) {
          this.db.prepare("DELETE FROM subscriptions WHERE wallet_pubkey = ? AND relay_url = ? AND endpoint = ?")
            .run(walletPubkey, relayUrl, row.endpoint);
          console.log(`[Gateway] Deleted expired subscription for ${walletPubkey}`);

          const listener = this.listeners.get(relayUrl);
          if (listener) {
            listener.updateSubscription();
          }
        }
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    if (this.server) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }

    for (const listener of this.listeners.values()) {
      listener.close();
    }
    this.listeners.clear();
    this.rgsCache.clear();

    if (this.db) {
      this.db.close();
      this.db = null;
    }

    this.isRunning = false;
  }

  status(): "Stopped" | "Running" {
    return this.isRunning ? "Running" : "Stopped";
  }
}
