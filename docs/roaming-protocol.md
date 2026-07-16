# The roaming-wallet protocol

How ONE Libre wallet (seed + Lightning channel state) safely MOVES between browser origins —
the standalone wallet PWA and sites embedding `@libre/wallet-embed` — without ever putting two
live nodes on the same channel (which is a force-close; see the 2026-07-06 postmortem in
CLAUDE.md). Implementation: `packages/wallet-core/src/roaming/` (`roaming-policy.ts` decisions,
`drive-lease.ts` I/O, `roaming-session.ts` orchestration) + `wallet-pwa/src/core/pwa-lease.ts`.

## Why this exists

- Browser storage is per-origin: a wallet on `libre-wallet-pwa.pages.dev` is invisible to
  `boostmebitch.com`. Third-party iframe storage is partitioned in modern browsers, so an
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
phase: "live"|"released", handoffAck?, unprovenPredecessor? }`. `owner` is a random per-session
token. Lease length 120s, heartbeat every 40s (the shared device-lease constants).

**The load-bearing rule is the handoff proof, not a version comparison.** A successor may only
restore the backup over a predecessor's state with *positive evidence* the backup holds that
predecessor's final state:

| Proof | Who authors it |
|---|---|
| `phase: "released"` | the predecessor, on a clean close, only once its flush provably landed |
| `handoffAck{from, flushedVersion}` (and `flushedVersion ≤ the backup's version`) | the predecessor, after its final flush |
| our own `state_version` ≥ the predecessor's advertised one | us — we ARE the origin holding the missing state |

No proof ⇒ **halt**, with an explicit user override (below). Silence is not proof: a dead holder
leaves no evidence either way, and an annoying, self-healing halt is recoverable where a
force-close is not.

`heartbeatStateVersion` is a **lower bound** on its writer's real state — never an upper one. It
can prove we're behind; it can't prove we're current. The original design had it the other way
round (halt when `advertised > backup`), which meant a holder that died *after* its last 40s
heartbeat left `advertised == backup` and sailed through the check — that gap force-closed a live
mainnet channel (issue #90).

`unprovenPredecessor` (`{owner, origin, advertisedVersion, since}`) snapshots whoever we claimed
the lease from without proof, and is **carried forward through every one of our own writes**.
It exists because `owner` cannot survive a reload (the token is per-page-life, so "is this record
mine?" is unanswerable afterwards) while our claim overwrites `heartbeatStateVersion` with our own
— 0 on a fresh origin. Without the carry, "Try again" or a refresh reads back our own zeroed record
and walks straight past the halt. Cleared only by a proven handoff or the user's override.

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
├─ handoff proof (evaluateHandoffProof): released / ack-within-backup / we-hold-the-state
│    (deferred until after secret entry when the backup version isn't readable yet)
│    NOT proven → HALT: "open <origin> once so it can sync"  [+ the override, below]
├─ no local wallet + backup → RESTORE-INTO-EMPTY (recovery phrase asked once per origin)
├─ no local wallet + no backup → SETUP-NEEDED (creation lives in the wallet PWA)
└─ local wallet → START (the controller's own guards — recoverOrHalt, backup-ahead,
     state-version mirror, channel-state regression — take it from there)
```

The halt is **retry-safe by construction**: our own claim always writes `phase: "live"` and never
an ack, so it cannot manufacture proof. Re-booting (the halt's "Try again") or reloading the page
re-derives the same verdict rather than laundering it away.

## The override — "the other device is gone"

Fail-closed alone would strand a wallet whose origin is genuinely gone (phone lost, broken, wiped).
So an overridable halt offers `RoamingSession.forceRestoreAnyway()` behind a **reveal + confirm**
(never a second button beside "Try again"): it states plainly that the channel will very likely be
force-closed and the funds return on-chain to the recovery address via the sweeper. That is the
same outcome the old code produced *silently* — the difference is informed consent.

It clears `unprovenPredecessor`, but does **not** survive a crash before our first flush: the
record still says `live` with no ack, so the next boot halts again. That's correct — at that point
we genuinely have no proof — and the user can override again.

## Move-here (takeover of a live holder)

1. Claimant writes the lease over the live holder (user action, never automatic).
2. The holder's next heartbeat (≤40s) READS FIRST, sees the foreign owner, and self-fences:
   drain WebLN spends → clean `stopNode()` → upload the backup **only if local is ahead of
   Drive** (never clobber a successor's flush) → write `handoffAck` into the claimant's record
   (without touching its ownership).
3. The claimant polls (≤90s) for the ack, then proceeds to the handoff-proof gate. Timing out
   means only "stop waiting — the holder is dead/offline"; with no ack there is no proof, so the
   gate halts. (The backup's Drive `modifiedTime` is deliberately **not** consulted: it names
   neither the writer nor the version, so it never proved anything — and since the holder uploads
   *before* it acks, believing it raced the claimant into halting on the happy path.)

## Closing cleanly (why the halt stays rare)

A halt is only tolerable if the normal "close the phone, open the laptop" case is *proven*, so
closing down is a first-class path, not a best-effort afterthought:

- **While running:** the Drive backup auto-syncs on every state change (5s debounce,
  `shouldDriveAutoSync` in `wallet-core/core/drive-sync-policy.ts` — shared by the PWA and the
  embed). The embed originally had **no auto-sync at all**, so its backup sat frozen at the version
  it roamed in with for a whole session; that is what made #90's gap 9 commitments wide.
- **`visibilitychange → hidden`:** the page is still alive and can await — flush, then release. On
  iOS this is what an app-switch or a browser close actually fires, so it's the hook that runs.
- **`pagehide`:** nothing can be awaited any more, so we synchronously *issue* a keepalive lease
  write (`writeAppDataFileSyncKeepalive`, against a page-life-cached file id). It records
  `released` only if the backup already provably holds our state; otherwise it honestly leaves the
  lease `live` at our true version, so the successor halts rather than restoring what we outran.
  The backup itself is **not** flushed here: exporting is async, and a page-death flush can never
  be issued in time.

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
| Open site B while site A's tab is alive | B blocked; Move-here evicts A cleanly (≤40s), A acks → B proceeds |
| A closed normally (app-switch / browser close), backup synced | `visibilitychange` flushed + released → B starts, no halt. **The path the design bets on** |
| Return to A with stale local state | A's controller sees the newer backup → silent wipe+restore self-heal (existing path) |
| A's tab killed with unflushed state | No proof → B **halts** ("open A once to sync"); reopening A syncs Drive and heals it (A proves via its own local state) |
| A's tab killed *with* everything flushed, but no close hook ran | Also a halt — we can't tell it apart from the line above. Cost of failing closed; the two close hooks are what make it rare |
| Kill inside the ~5s auto-sync debounce | Halt (previously: a silent stale restore → force-close). `pagehide` records `live` at the true version; the un-flushed window is bounded by the debounce |
| A is gone for good (lost/broken phone) | Halt → the user's explicit override → restore + near-certain force-close, funds swept on-chain. Informed, not silent |
| Drive down at embed boot | Paused (fail closed), no node |
| Drive down while running | Keep running through blips; self-fence after >120s of failed renewals |
| Two origins race acquire within seconds | settle + read-back + confirmation read; residual same-user races fenced by the first heartbeat |

## Residual risks (accepted + documented)

- **Fail-closed costs halts, by design.** Any close that records nothing (a hard kill where neither
  hook runs) halts the next origin even when the backup happened to be current — we cannot tell the
  two apart, and only one of them is safe to guess at. Recovery is to reopen the old origin; the
  override covers the case where that's impossible.
- **Mixed-version fleets.** `unprovenPredecessor` is additive, but its absence means "no known
  predecessor", which for *this* field is the less-safe direction — an old deployed embed's
  `buildLeaseRecord` drops it. The primary proof test (`released` / ack) still halts regardless, so
  the worst case is today's behaviour and only while a stale build still participates. Remove this
  note once old embed tarballs have aged out.
- **The un-flushed window is bounded, not eliminated.** A holder that dies between a state advance
  and its debounced flush leaves state Drive never saw. It is now always a *halt* rather than a
  silent stale restore — but it still needs the old origin (or the override) to resolve.
- Drive write-then-verify is not a true CAS; the `LeaseStore` interface exists so a CAS-capable
  backend (VSS server / gateway) can replace it without touching the policy layer.
