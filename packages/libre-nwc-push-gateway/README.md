# `@libre/nwc-push-gateway`

The **Libre NWC Push Gateway** is a server-side background notification relay daemon. It connects to Nostr relays to track encrypted NWC requests (kind `23194`) and wakes up the PWA's browser **Service Worker** via standard **Web Push Notifications** when the wallet is offline/closed.

---

## Architectural Principles

* **Zero-Custody Guarantee**: The gateway is stateless regarding wallet credentials. It does **not** have access to the user's private keys or NWC NIP-47 shared secrets. It acts as a blind notification router, unable to read transaction values, preimages, or destinations.
* **Database Isolation**: The gateway uses its own isolated SQLite database to store push subscriptions. It never interacts with, reads, or writes to the host application's database.
* **Dynamically CURATED Relays**: Connects only to relays and pubkeys requested during client registration.

---

## API Reference

### 1. `GET /api/vapid-public-key`
Serves the VAPID public key. The gateway automatically generates and saves VAPID keys in its SQLite database if none exist on boot.

**Response**:
```json
{
  "publicKey": "BHA1fV..."
}
```

### 2. `POST /api/register`
Registers a browser subscription mapping a `walletPubkey` and Nostr `relayUrl` to a Web Push subscription.

**Request Body**:
```json
{
  "walletPubkey": "hex_wallet_pubkey",
  "relayUrl": "wss://relay.damus.io",
  "subscription": {
    "endpoint": "https://updates.push.services.mozilla.com/wpush/v2/...",
    "keys": {
      "p256dh": "p256dh_key_base64",
      "auth": "auth_secret_base64"
    }
  }
}
```

### 3. `POST /api/unregister`
Removes a subscription pairing from the SQLite database.

---

## Running the Daemon

```bash
# Start development daemon (compiles with tsup)
pnpm dev

# Run unit tests (uses isolated in-memory SQLite DB)
pnpm test
```
