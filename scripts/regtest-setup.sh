#!/usr/bin/env bash
#
# Bootstrap the local regtest stack so the integration tests can run.
#
# `docker compose up -d` starts bitcoind/electrs/lnd/websockify, but LND comes up
# with an auto-created (--noseedbackup) wallet that has NO on-chain funds, so it
# cannot open the channels the integration tests need. This script funds LND by
# mining matured coinbase to one of its addresses, which also gives the chain a
# recent block timestamp so LND reports synced_to_chain=true on regtest.
#
# Usage:
#   docker compose up -d
#   ./scripts/regtest-setup.sh
#   pnpm --filter @libre/listener-wallet exec vitest run src/tests/integration
#
set -euo pipefail

BCLI="docker exec libre-bitcoind bitcoin-cli -regtest -rpcuser=libre -rpcpassword=listener"
LNCLI="docker exec libre-lnd lncli --network=regtest"

echo "[setup] Waiting for LND RPC to come up..."
for i in $(seq 1 30); do
  if $LNCLI getinfo >/dev/null 2>&1; then break; fi
  [ "$i" = "30" ] && { echo "[setup] ERROR: LND RPC never came up. Is the stack running?"; exit 1; }
  sleep 2
done

PUBKEY=$($LNCLI getinfo | sed -n 's/.*"identity_pubkey": *"\([^"]*\)".*/\1/p')
echo "[setup] LND node id: ${PUBKEY}"

CONFIRMED=$($LNCLI walletbalance | sed -n 's/.*"confirmed_balance": *"\([0-9]*\)".*/\1/p' | head -1)
if [ "${CONFIRMED:-0}" -gt 0 ]; then
  echo "[setup] LND already funded (${CONFIRMED} sat confirmed). Nothing to do."
  exit 0
fi

ADDR=$($LNCLI newaddress p2wkh | sed -n 's/.*"address": *"\([^"]*\)".*/\1/p')
[ -n "$ADDR" ] || { echo "[setup] ERROR: could not get an LND address"; exit 1; }
echo "[setup] Funding LND at ${ADDR} (mining 101 blocks for mature coinbase)..."
$BCLI generatetoaddress 101 "$ADDR" >/dev/null

echo "[setup] Waiting for LND to sync and see the funds..."
for i in $(seq 1 30); do
  INFO=$($LNCLI getinfo)
  BAL=$($LNCLI walletbalance | sed -n 's/.*"confirmed_balance": *"\([0-9]*\)".*/\1/p' | head -1)
  if echo "$INFO" | grep -q '"synced_to_chain": true' && [ "${BAL:-0}" -gt 0 ]; then
    echo "[setup] Done. LND synced and funded with ${BAL} sat."
    exit 0
  fi
  sleep 2
done

echo "[setup] ERROR: LND did not sync/fund in time."
exit 1
