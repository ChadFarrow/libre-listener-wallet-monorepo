# Soak testing — hunting the "channel info reset" force-close

These soaks reproduce, on local regtest, the failure class behind the force-closes seen during
NWC use: **state desync when the node reloads under payment load** ("a channel info reset closed
the channel"). Each soak opens one channel, drives payments, and RESTARTS the wallet on the same
storage — a fresh instance re-reading the same DB, exactly what a browser reload / offscreen-reap
does — asserting the channel survives. Every anomaly (force-close event, regression halt,
non-monotonic state, lost channel, lnd force-close) is collected and reported at the end, so a long
run surfaces intermittent gotchas instead of bailing on the first.

## Prerequisites (once)

```bash
docker compose up -d      # regtest stack: bitcoind, electrs, lnd (+ lnd-payer), all on 127.0.0.1
```

Give lnd a few seconds to sync. Each soak is a vitest integration test; they're excluded from CI
(docker-backed) and only run when you run them. Cycle counts are env-configurable — start small,
then crank them for a longer hunt (they leave the channel intact between cycles).

## The three soaks

### 1. Restart soak — the baseline
Payments go directly through the SDK send/receive path (the same channel-state-advance + persist
path NWC drives). Alternates keysend-send and invoice-receive, restarts each cycle.

```bash
SOAK_CYCLES=50 pnpm --filter @libre/listener-wallet exec vitest run \
  src/tests/integration/soak-nwc-restart.test.ts
```

### 2. NWC-path soak — the faithful reproduction
Payments go through the REAL NWC/Nostr flow: an in-process Nostr relay carries NIP-47 traffic
between a test NWC client and the wallet's `NwcManager`. Each cycle sends a real `pay_keysend`
(and every other cycle a `make_invoice` that lnd pays), then restarts. This is the closest match to
the session that force-closed.

```bash
NWC_CYCLES=20 pnpm --filter @libre/listener-wallet exec vitest run \
  src/tests/integration/soak-nwc-e2e.test.ts
```

### 3. VSS-recovery soak — proves the fix
Each cycle pays, lets the VSS mirror upload the encrypted state, then WIPES all local storage except
the seed (simulating the reset / storage loss), restarts, and asserts the wallet RE-HYDRATES the
channel from the VSS durable replica and reconnects with **no force-close** — instead of
bootstrapping an empty node and force-closing on reestablish. Uses an in-process VSS server, so no
extra infra beyond docker regtest.

```bash
VSS_RECOVER_CYCLES=5 pnpm --filter @libre/listener-wallet exec vitest run \
  src/tests/integration/soak-vss-recovery.test.ts
```

### 4. Boost-split soak — the V4V fan-out
The real v4vmusic workload: one boost fans out into `SPLITS_PER_BOOST` keysends (bLIP-10 TLV —
shared `boost_uuid`, unique `uuid` per recipient), fired concurrently through the wallet's real
`NwcManager` (`pay_keysend`), then a restart. Reproduces the many-rapid-in-flight-HTLC churn a boost
generates, and verifies every split arrives at lnd carrying the shared `boost_uuid` (the split
invariant). In regtest all splits land at the one channel peer; a real boost fans out to many nodes,
but the local state churn is the same.

```bash
BOOST_CYCLES=5 SPLITS_PER_BOOST=6 pnpm --filter @libre/listener-wallet exec vitest run \
  src/tests/integration/soak-nwc-boost-splits.test.ts
```

## Reading the results

- Each cycle logs a one-liner; the run ends with a `SUMMARY` and every `[GOTCHA] cycle N :: kind ::
  detail`. A green run means zero gotchas.
- A `regression-halt-on-restart` gotcha means `start()` tripped `ChannelStateRegressionError` on a
  clean restart — the guard is the safe outcome, but on a *clean* restart it's a real finding
  (a false-halt) worth investigating.
- A `force-close-*` / `lnd-sees-force-close` gotcha is the bug we're hunting: capture the cycle's
  log and the lnd `pendingchannels` / `channel_reestablish` output.

## Docker-free coverage (runs in CI too)

The transports these soaks depend on are also unit-tested without docker, so a soak failure can't be
blamed on the harness:
- `src/tests/unit/vss-test-server.test.ts` — real VssClient ⇄ the in-memory VSS server (round-trip,
  blind write, stale-version conflict, store isolation).
- `src/tests/unit/nostr-relay.test.ts` — the in-process relay routes events between nostr-tools
  clients.
