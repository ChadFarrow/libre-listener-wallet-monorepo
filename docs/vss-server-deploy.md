# VSS server — deploy (Railway, alongside the gateway)

The wallet can mirror its channel-critical state to an **LDK Versioned Storage Service (VSS)** —
a versioned, encrypted-blob KV store — as a **durable, off-device replica**. This is the fix for
the dominant browser force-close cause: an offscreen doc / service worker is reaped, local
IndexedDB is lost or stale, the node reloads old state and replays it at the peer
(`channel_reestablish` data-loss) → the peer force-closes. With VSS, when an origin has the seed
but no local `channel_manager`, the SDK **re-hydrates from VSS before dialing** instead of
bootstrapping an empty node.

The **client is already built and shipped behind a flag** (`WalletConfig.vssUrl`, default unset =
disabled): `vss-client.ts` (protobuf-over-HTTP), `vss-mirror.ts` (write path), and the `start()`
re-hydration (`maybeRestoreStateFromVss`). This doc is the **server + wiring** half.

## Guardrail posture (unchanged)

- **Ciphertext only.** The wallet uploads the *same* slim, seed-encrypted backup envelope the Drive
  backup already produces (`exportState` → `serializeAndEncryptV1`). The server never sees a seed,
  preimage, or plaintext state — it stores an opaque blob. Key-isolation guardrail holds.
- **DB isolation.** VSS gets its **own** database (its own Postgres), never the gateway's SQLite or
  any host-app DB — same rule as the gateway.
- **Zero-custody.** Like the push gateway, VSS routes blind encrypted data; losing the server loses
  a *replica*, never funds (local IndexedDB + the user's seed/Drive backup remain).

## Which implementation

Use **`MutinyWallet/vss-rs`** (Rust, Postgres-backed, Dockerized) — the battle-tested self-hostable
VSS server Mutiny ran in production. (`lightningdevkit/vss-server`, the Java/Kotlin reference, also
works but needs more setup.) Both speak the same protobuf HTTP API our client targets:
`POST /getObject | /putObjects | /listKeyVersions | /deleteObject`, `application/octet-stream`.

## Deploy as its own Railway service (in the gateway project)

Mirror the **ws-bridge** pattern — a separate service inside the existing
`libre-nwc-push-gateway` Railway project:

1. **New service** from the `vss-rs` image/repo (Dockerfile deploy).
2. **⚠️ Root Directory gotcha** (cost the ws-bridge hours): if you vendor a Dockerfile into this
   monorepo, set the service's **Root Directory** to that folder, or Railway reads the repo-root
   `/railway.json` (the *gateway's*, with a `/api/vapid-public-key` healthcheck a VSS server can't
   answer) and every deploy fails. Simplest: deploy `vss-rs` from its **own upstream repo/image**,
   not from this monorepo, so there's no root-config collision.
3. **Add a Postgres plugin** to the project and point VSS at it (its own DB — DB-isolation).
4. **Env** (see `vss-rs` README for exact names): the Postgres `DATABASE_URL`, listen port, and the
   auth config below.
5. **Healthcheck**: a VSS RPC path (e.g. `POST /listKeyVersions`) or a `/health` route if the image
   exposes one — NOT the gateway's `/api/vapid-public-key`.

Public endpoint becomes e.g. `https://vss-production-xxxx.up.railway.app`.

## Auth model — decide before going public

VSS's `store_id` namespaces one wallet's keys. Our client derives it as
`SHA-256("libre-vss-store-v1:" + seedHex)` (`deriveVssStoreId`) — a 256-bit, **unguessable** value
that never contains the seed. That makes the store id a *bearer capability*, but it is sent on every
request, so treat it like one:

- **Confidentiality is already covered** — blobs are seed-encrypted; a leaked store id can't decrypt
  anything.
- **Integrity is the gap** — the client mirrors with a **blind write** (VSS `version = -1`, exactly
  like LDK's own VssStore, since a wallet is its state's sole writer), so anyone who learns a store
  id could *overwrite/delete* that blob (griefing). Mitigate with one of:
  - **Recommended for the first regtest + mainnet soak:** run VSS **private / not publicly routable**
    (internal to the Railway project, reached only by the gateway, or IP-allowlisted), leaning on the
    unguessable store id. Fastest path to validating the end-to-end recovery.
  - **For a public production endpoint:** enable VSS **auth (JWT or LNURL-auth)** and bind each token
    to its store id. This needs a small **client change** (send an `Authorization` header from
    `VssClient` / obtain a token) — a follow-up, tracked, not required for the soak.

## Wire the apps (after the server is up)

The SDK reads `WalletConfig.vssUrl`. Default the apps to the Railway URL the same way the other
mainnet infra is wired, keeping it **off until the server is live**:

- **example-app / PWA:** add `VITE_MAINNET_VSS=https://<vss-svc>.up.railway.app` to `.env.local`
  (and the static host build env), resolved mainnet-only like `VITE_MAINNET_RGS`; pass it as
  `config.vssUrl` where the wallet is constructed.
- **browser-extension:** add a `defaultVssUrl` in `core/wallet-config.ts` next to
  `defaultBridgeUrl`/`defaultRapidGossipSyncUrl`, plumbed into the offscreen wallet host's config.

Leave `vssUrl` unset to keep VSS fully disabled (no behavior change).

## Verify end-to-end (regtest)

1. Point a regtest wallet's `config.vssUrl` at a local `vss-rs` (docker) + Postgres.
2. Fund a channel; confirm the mirror uploaded (`[VSS] Mirrored state backup …` in logs; a
   `getObject` on `state_backup` returns a non-empty blob).
3. **Wipe the IndexedDB `channel_manager`** (simulate an offscreen-reap) but keep `ldk_seed`.
4. Restart → expect `[VSS] Re-hydrated channel state from durable replica` and a working channel
   (keysend still settles) — **no force-close**, regression guard passes. This extends
   `packages/libre-listener-wallet/src/tests/integration/recovery.test.ts`.
5. **Guardrail check:** confirm the VSS request bodies on the wire / server logs are opaque
   ciphertext (no seed / preimage / plaintext state).
