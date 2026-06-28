import webpush from "web-push";
import Database from "better-sqlite3";
import { Relay } from "nostr-tools";

export interface GatewayConfig {
  host?: string;
  port: number;
  relayUrl?: string;
  dbPath?: string;
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
      this.connect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
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

  constructor(config: GatewayConfig) {
    this.config = {
      host: config.host || "127.0.0.1",
      port: config.port,
      relayUrl: config.relayUrl,
      dbPath: config.dbPath
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
        console.error("Registration error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    app.post("/api/unregister", (req, res) => {
      try {
        const { walletPubkey, relayUrl } = req.body;
        if (!walletPubkey || !relayUrl) {
          res.status(400).json({ error: "Missing parameters" });
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
        res.status(500).json({ error: err.message });
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
      try {
        const upstream = await fetch(`https://rapidsync.lightningdevkit.org/snapshot/${ts}`);
        if (!upstream.ok) {
          res.status(upstream.status).end();
          return;
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.set("Content-Type", "application/octet-stream").send(buf);
      } catch (err: any) {
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
    const walletPubkey = event.tags.find((t: string[]) => t[0] === "p")?.[1];
    if (!walletPubkey) return;

    const rows = this.db.prepare("SELECT endpoint, p256dh, auth FROM subscriptions WHERE wallet_pubkey = ? AND relay_url = ?")
      .all(walletPubkey, relayUrl) as { endpoint: string; p256dh: string; auth: string }[];

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
