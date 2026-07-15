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
| 7 | Kill A's tab HARD mid-payment (task manager, not close) | — |
| 8 | Open B, Connect | Either runs (the pagehide flush landed) or **halts** with "open localhost:5174 once so it can sync" — NEVER a stale restore |
| 9 | If halted: reopen A | A starts on its intact local state, flushes, hands off cleanly; B then works |
| 10 | With B running, open the wallet PWA and hit Start | Refused: "Your wallet is active on 127.0.0.1:5174" |

Final assertion: `docker exec libre-lnd lncli --network=regtest closedchannels` → empty; channel
still usable from whichever origin currently holds the wallet.

## Automated coverage

The same interleavings run as unit tests over an in-memory fake Drive:
`packages/wallet-core/src/roaming/*.test.ts` (46 tests: races, expiry takeover, crash gaps,
outage self-fence, the full A→B→A cycle) and `wallet-pwa/src/core/pwa-lease.test.ts`. A docker
soak (`soak-roam-cycle`) is the planned M3 follow-up.
