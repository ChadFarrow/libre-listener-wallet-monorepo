# Custody Model — Libre Listener Wallet

**Status: non-custodial.** The user holds their own keys in their browser; no component anyone
operates can move user funds. This document maps every piece of infrastructure to its exposure, so
it's clear what each party runs and where (if anywhere) regulatory questions land.

> ⚠️ **Not legal advice.** This describes the *architecture* — what touches keys and funds. Whether
> running an **LSP** counts as money transmission is **jurisdiction-specific** and must be reviewed
> by qualified counsel. This doc supports that review; it does not replace it.

---

## Roles (who runs what)

| Party | Runs | Touches user keys/funds? |
|---|---|---|
| **App developer** (you) | Static PWA host, websockify **bridge**, **push gateway**, **RGS proxy** — software + *blind relays* | **No** |
| **LSP operator** (a *separate* third party) | The Lightning node that opens channels, supplies liquidity, and forwards payments | No *unilateral* control (see below) — but this is the role that carries any money-transmitter exposure |
| **User** | The wallet (LDK in their browser); holds the seed | Yes — it's their own self-custody |

The role split is deliberate: the **app developer never becomes a custodian or transmitter** by
only shipping code and running blind relays. The liquidity/forwarding role — and its regulatory
surface — sits with the **LSP operator**. The current own-node (`028ea4…@45.33.65.45`) is a
**temporary test stand-in for a real LSP**, not the target topology.

---

## Per-component custody map

| Component | Run by | Data it handles | On-the-wire | Key/fund exposure | Classification |
|---|---|---|---|---|---|
| **Static PWA host** | App dev | HTML/JS/WASM | HTTPS | None — wallet + seed live in the user's browser sandbox | Code delivery |
| **websockify bridge** | App dev | The LDK peer byte stream | **Noise-encrypted** (LDK transport) | None — can't read keys, payments, or balances; never holds funds | **Blind pipe** |
| **Push gateway** | App dev | Push-subscription rows + relay wakeups | NWC payloads are **NIP-04 encrypted**; gateway never decrypts | None — stores no node key / NWC secret | **Blind relay** |
| **RGS proxy** | App dev | The **public** Lightning gossip graph | HTTPS | None — public data only, no user data | Public-data CDN |
| **Google Drive** | Google (user's account) | The encrypted backup blob | **Seed-encrypted before upload** | None in plaintext — ciphertext only | Encrypted blob store |
| **LSP node** | **Separate operator** | Channel liquidity, payment forwarding | Lightning P2P | No *unilateral* control of user funds; user can force-close + sweep | Non-custodial; **legal-review item** |

---

## Audit findings (verified in code)

1. **Bridge is a blind pipe.** `connectPeer` wires the socket so inbound bytes go straight to
   `peerManager.read_event` and outbound bytes are `peerManager` output — i.e. only the
   Noise-encrypted LDK transport. No seed/private-key/preimage path crosses it.
   `packages/libre-listener-wallet/src/index.ts:1011` (onmessage `read_event` ~:1029).
2. **Push gateway never decrypts and holds no spendable secret.** `handleNwcEvent` reads only the
   `p` tag (wallet pubkey) to look up push subscriptions and send a wakeup — it never touches
   `event.content`. The subscriptions table stores `wallet_pubkey, relay_url, endpoint, p256dh,
   auth` only; the sole `private_key` in the DB is the gateway's own **VAPID** web-push signing key.
   `packages/libre-nwc-push-gateway/src/index.ts:279-288` (handler), `:137-145` (schema), `:135/151`
   (VAPID).
3. **Backups are encrypted before they leave the device.** `exportState()` returns the output of
   `serializeAndEncrypt`/`serializeAndEncryptV1` (AES-256-GCM); the Drive upload sends *that*
   ciphertext. The seed lives *inside* the encrypted payload, never in plaintext on the wire.
   `index.ts:887/928-930`, `state-backup.ts:103-132`, `example-app/src/main.ts:1078/1112`.
4. **Keys stay in the user's storage.** `ldk_seed` (`index.ts:287/292`) and the NWC wallet privkey
   `nwc_wallet_private_key` (`nwc-manager.ts:93/97`) are only ever read/written via the injected
   `SecureStorageProvider` (IndexedDB in the browser) — never serialized to a socket or HTTP. The
   NWC *connection secret* is held by the client app; the gateway sees only ciphertext.
5. **Preimage guardrail.** `make_invoice` never returns the preimage over the relay (asserted in
   `nwc.test.ts`). Audit found two log lines that printed an inbound-claim preimage to the local
   logger (`index.ts:581/586`) — these never left the sandbox, but violated "no preimages in logs"
   and were **redacted to log the payment hash instead**.
6. **Self-custody exit.** Channel state is an LDK `ChannelMonitor` the user controls; with the seed
   they can restore and **unilaterally force-close + sweep** on-chain. No hosted component can block
   or seize funds — the defining non-custodial property. Restore is seed-only (`importState`).

No component operated by the app developer can read keys, read payment contents, or move funds.

---

## Trust boundaries

- **Plaintext only inside the user's browser sandbox:** the seed, private keys, unclaimed-HTLC
  preimages, and decrypted NWC requests.
- **Everything that crosses the wire is encrypted:** the Lightning transport (Noise) through the
  bridge; NWC requests/responses/notifications (NIP-04) through the relay + gateway; backups
  (seed-encrypted envelope) to Drive. The RGS proxy carries only public gossip.

---

## LSP — the one legal-review item

The LSP is run by a **separate operator**, by design, so the liquidity/forwarding role stays off
the app developer. It is still **non-custodial** toward the user (it never has unilateral control;
the user can always force-close), but:

- **(a)** Whether providing liquidity / forwarding payments is "money transmission" is
  **jurisdiction-specific** → the **LSP operator** should obtain counsel.
- **(b)** This risk-offload holds **only while the app developer does not operate or control the
  LSP.** Connect to *independent* LSPs. If you ever run one, treat it as a **separate legal entity**
  — its regulatory surface returns to whoever runs it.
- **(c)** The current own-node is **temporary testing**, not the production topology.

---

## Anti-patterns that would BREAK non-custody (never add)

- The push gateway (or any server) holding **NWC shared secrets** or **node keys**.
- An LSP taking **custodial pre-funded deposits** it controls.
- **Server-side storage** of any seed, private key, or preimage (even "temporarily").
- A **refresh token / credential** that lets any backend **spend on a user's behalf**.

Each of these would convert a blind relay into a custodian. The guardrails in
`ai/contracts/guardrails.md` exist to prevent exactly this.
