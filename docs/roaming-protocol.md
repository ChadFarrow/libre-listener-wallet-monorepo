# The roaming-wallet protocol

How ONE Libre wallet (seed + Lightning channel state) safely MOVES between browser origins —
the standalone wallet PWA and sites embedding `@libre/wallet-embed` — without ever putting two
live nodes on the same channel (which is a force-close; see the 2026-07-06 postmortem in
CLAUDE.md). Implementation: `packages/wallet-core/src/roaming/` (`roaming-policy.ts` decisions,
`drive-lease.ts` I/O, `roaming-session.ts` orchestration) + `wallet-pwa/src/core/pwa-lease.ts`.

## Why this exists

- Browser storage is per-origin: a wallet on `libre-wallet-pwa.pages.dev` is invisible to
  `boostmebitch.vercel.app`. Third-party iframe storage is partitioned in modern browsers, so an
  iframe can't share it either.
- A Lightning channel's state may only ever advance in ONE running node. "Same seed everywhere"
  must therefore mean **move, not share**.
- Web Locks (the in-origin single-node lock) don't cross origins; the VSS device lease needs a
  deployed VSS server. The only coordination substrate every participant already has is the
  user's **Google Drive appDataFolder** (the backup's home) — so the lease rides there too.

## The files (per network, in Drive appDataFolder)

| File | Contents |
|---|---|
| `libre-wallet-backup-<network>.json` | The encrypted backup envelope (pre-existing; carries `state_version`). |
| `libre-wallet-lease-<network>.json` | The roaming lease (new; storage-contract-pinned filename). |

Lease record: `{ v, owner, origin, appName?, acquiredAt, expiresAt, seq, heartbeatStateVersion,
phase: "live"|"released", handoffAck? }`. `owner` is a random per-session token. Lease length
120s, heartbeat every 40s (the shared device-lease constants).

**`heartbeatStateVersion` is the load-bearing field:** every renewal stamps the holder's local
`state_version`. A successor comparing it against the backup file's version can *detect* "the
last session died without flushing" — the crash gap — and halt instead of restoring a stale
snapshot onto a live channel.

## No CAS on Drive → write-then-verify

Drive has no compare-and-swap, so acquiring is: read → decide → write own record → settle delay
(2s + jitter) → read back (a concurrent claimant whose write landed later wins the file; the
loser sees the foreign token and backs off) → a **second confirmation read** right before
`startNode()`.

Two deliberate policy inversions vs. the (advisory) VSS device lease:

- **Fail closed at boot:** lease unreachable ⇒ no node (the embed shows "wallet paused"). A
  paused wallet is an inconvenience; two live nodes is a force-close. (The wallet PWA is the one
  exception — see below.)
- **Self-fence on outage:** a running holder whose renewals have failed for longer than the
  lease window stops itself — any other origin may now legitimately consider the lease lapsed.

## Boot decision (per origin)

```
peek lease (never write yet)
├─ live foreign lease → BLOCKED ("active on <origin>" + Move-here)
├─ crash-gap check: lease.heartbeatStateVersion > backup version
│    (skipped for released leases; deferred until after secret entry when the backup
│     version isn't readable yet; skipped when OUR local copy holds the missing state)
│    → HALT: "open <origin> once so it can sync"
├─ no local wallet + backup → RESTORE-INTO-EMPTY (recovery phrase asked once per origin)
├─ no local wallet + no backup → SETUP-NEEDED (creation lives in the wallet PWA)
└─ local wallet → START (the controller's own guards — recoverOrHalt, backup-ahead,
     state-version mirror, channel-state regression — take it from there)
```

## Move-here (takeover of a live holder)

1. Claimant writes the lease over the live holder (user action, never automatic).
2. The holder's next heartbeat (≤40s) READS FIRST, sees the foreign owner, and self-fences:
   drain WebLN spends → clean `stopNode()` → upload the backup **only if local is ahead of
   Drive** (never clobber a successor's flush) → write `handoffAck` into the claimant's record
   (without touching its ownership).
3. The claimant polls (≤90s) for the ack or a fresher backup `modifiedTime`, then proceeds
   through the crash-gap check. Timeout means the holder is dead/offline — the gap check is
   then the real safety decision.

## The wallet PWA participates too (`core/pwa-lease.ts`)

- `startNodeWithGuards` refuses to start while a live foreign lease exists (Drive connected).
- While running with Drive connected, the PWA claims + heartbeats; eviction self-fences with the
  same flush-if-ahead + ack dance.
- **Offline-first start is unchanged:** with Drive unreachable there is no lease to consult, so
  the iOS cold-load auto-start path behaves exactly as before. The auto-start ↔ Drive-connect
  race is closed reactively: the first claim attempt that finds a live foreign lease stops the
  node instead of running alongside it.

## Failure modes

| Scenario | Outcome |
|---|---|
| Open site B while site A's tab is alive | B blocked; Move-here evicts A cleanly (≤40s) |
| Return to A with stale local state | A's controller sees the newer backup → silent wipe+restore self-heal (existing path) |
| A's tab killed WITHOUT its final flush | B sees `heartbeatStateVersion` > backup version → HALT with "open A once to sync"; reopening A heals Drive |
| Kill inside the ~5s debounce after the last payment | Undetectable-by-design residual: stale restore → peer force-close → the existing sweeper recovers funds on-chain. Mitigated by the `pagehide` keepalive flush (KB-sized envelope) |
| Drive down at embed boot | Paused (fail closed), no node |
| Drive down while running | Keep running through blips; self-fence after >120s of failed renewals |
| Two origins race acquire within seconds | settle + read-back + confirmation read; residual same-user races fenced by the first heartbeat |

## Residual risks (accepted + documented)

- The debounce-window crash gap above (bounded by the sweeper — funds recovered on-chain, the
  channel is lost).
- Drive write-then-verify is not a true CAS; the `LeaseStore` interface exists so a CAS-capable
  backend (VSS server / gateway) can replace it without touching the policy layer.
