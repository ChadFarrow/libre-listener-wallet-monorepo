# Two-origin roaming verification (manual, regtest)

Proves the roaming protocol end-to-end on one machine: two REAL origins
(`http://localhost:5174` vs `http://127.0.0.1:5174` — different origins, separate IndexedDB)
roaming one wallet over one Google account, with a funded regtest channel that must NEVER
force-close. Run before calling the roaming layer shippable (M1 gate).

## Setup

1. `docker compose up -d` (bitcoind, esplora :3002, lnd LSP, ws bridge :8091) and the dev LSP:
   `pnpm --filter @libre/lsps2-server build && LND_MACAROON_HEX=$(cat /tmp/libre-lnd-admin.macaroon.hex) node packages/libre-lsps2-server/server.cjs`
2. Google OAuth client: ensure `http://localhost:5174` AND `http://127.0.0.1:5174` are in
   Authorized JavaScript origins + redirect URIs; your Google account on Test users.
3. Wallet PWA dev server (`pnpm --filter @libre/wallet-pwa dev`, regtest config): create + fund
   the wallet (Request Invoice via the LSPS2 flow), connect Google Drive, verify the backup
   synced, then STOP the node / close the tab.
4. Embed demo host: `pnpm --filter @libre/wallet-embed dev` → serves the demo on `:5174`.
   Set `localStorage.libre_google_client_id` on both origins (or edit demo/main.ts).

## Walk (watch `lncli closedchannels` stay EMPTY throughout)

| # | Step | Expect |
|---|---|---|
| 1 | Open origin A (`localhost:5174`), Connect | Drive sign-in → "Enter recovery phrase" (once) → running, balance shows |
| 2 | `webln.keysend` / pay via the demo buttons | settles; balance moves |
| 3 | Open origin B (`127.0.0.1:5174`), Connect | **blocked**: "active on localhost:5174" |
| 4 | Tap **Move wallet here** on B | B shows "moving…"; within ~40s A flips to "wallet moved to 127.0.0.1:5174" (node stopped); B proceeds to phrase entry → running |
| 5 | Pay on B | settles |
| 6 | Close B's tab cleanly, reopen A, Connect | A self-heals (silent wipe+restore from the newer backup) → running; pay works |

### The #90 block: an origin that dies without a clean close

This is the sequence that force-closed a live mainnet channel, and every row below is a
*deterministic* expectation. If any of them "sometimes runs instead", the proof gate is not doing
its job — that ambiguity is what the old crash-gap check had, and it is what shipped the bug.

Step 8 must be a HARD kill: DevTools → Application → Service Workers/Task Manager "Discard", or
kill the tab process. Closing the tab normally fires `visibilitychange`/`pagehide` and is a
*clean* close — that's step 7, and it's a different test.

| # | Step | Expect |
|---|---|---|
| 7 | **Clean close:** pay on A, then close A's tab normally. Open B, Connect | **Runs. No halt.** The `visibilitychange` flush + `released` lease is the whole bet of the design — if this halts, roaming is unusable and the override becomes a reflex |
| 8 | **Hard kill:** pay on A, then kill A's tab (no close hooks). Open B, Connect | **Halts**: "open localhost:5174 once so it can sync". **Never a restore.** ← this is issue #90 |
| 9 | On that halt, press **Try again** | **Halts again.** (It re-boots and reads back *our own* claim — the old code took this as "nothing to worry about" and restored) |
| 10 | On that halt, **reload B's page** | **Halts again.** (A reload mints a new owner token, so B reads its own prior record as a foreign live lease → blocked → Move-here → halt) |
| 11 | Reopen A, Connect | A starts on its intact local state (it proves via `localStateVersion ≥ advertised`), flushes Drive, hands off cleanly; B then works. **This is the self-heal the halt copy promises — if it doesn't work, the halt is a trap** |
| 12 | **The override** (do this LAST — it force-closes): halt B again per #8, click "…is gone for good" | Reveals the force-close warning. **The confirm button does not exist until this click**, and revealing must not restore |
| 13 | Click "I understand — restore anyway" | Restores → the peer force-closes. `closedchannels` gets an entry; funds sweep on-chain to the recovery address. **This is the one expected close in the whole walk** |
| 14 | With B running, open the wallet PWA and hit Start | Refused: "Your wallet is active on 127.0.0.1:5174" |

Final assertion: `docker exec libre-lnd lncli --network=regtest closedchannels` → **empty through
step 11** (steps 12–13 deliberately close it, so do them last or on a throwaway channel); channel
still usable from whichever origin currently holds the wallet.

Worth watching in the Drive appDataFolder (`libre-wallet-lease-regtest.json`) as you go:
`phase` should be `released` after step 7's clean close, and `live` with a truthful
`heartbeatStateVersion` after step 8's kill. An `unprovenPredecessor` appearing on B's record is
what makes steps 9–10 halt.

## Automated coverage

The same interleavings run as unit tests over an in-memory fake Drive:
`packages/wallet-core/src/roaming/*.test.ts` (races, expiry takeover, the invisible crash gap,
retry/reload safety, the override, outage self-fence, the full A→B→A cycle) and
`wallet-pwa/src/core/pwa-lease.test.ts`. A docker soak (`soak-roam-cycle`) is the planned M3
follow-up.

**What the unit tests cannot cover, and why this manual walk still exists:** the fakes model Drive
as an in-memory map, so they cannot exercise the real `keepalive` PATCH surviving page death, the
page-life file-id cache, whether iOS actually fires `visibilitychange` before reaping the tab, or
real OAuth. Step 7 in particular is a *browser behaviour* claim, not a logic claim — no test in
this repo can prove it.
