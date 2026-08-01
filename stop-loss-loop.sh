#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# stop-loss-loop.sh  —  Infinite loop that reads the XTIUSDT last price
#                        from xtiusdt-last-price.txt, subtracts $0.05, and
#                        places a reduce-only stop-loss conditional order
#                        at that price (triggered by last price).
#
# Usage:
#   ./stop-loss-loop.sh [delay_seconds]
#
# Default delay between iterations: 60 seconds.
# Press Ctrl-C to stop.

export PHEMEX_API_KEY="c9567d8a-cea7-403a-9d74-fa8395876aef"
export PHEMEX_API_SECRET="YiEqDwq34pOc9z1PkN1TTbLXUuj2VhFa9uXasR6JC503YzMzY2U5MC03M2E2LTQ5MjItOTI5YS1hODYxMjE3MzY0Zjg"
export PHEMEX_API_URL=https://api.phemex.com

set -euo pipefail

cd "$(dirname "$0")"

# ── Config ──────────────────────────────────────────────────────────
DELAY="${1:-60}"                     # seconds between loop iterations
PRICE_FILE="xtiusdt-last-price.txt"
CONDITIONAL="./scripts/phemex-add-conditional-orders.ts"
# ────────────────────────────────────────────────────────────────────

log() { echo "[$(date '+%F %T')] $*"; }

# ── Main loop ───────────────────────────────────────────────────────
log "stop-loss-loop started (delay=${DELAY}s)"
log "Press Ctrl-C to stop."
echo

while true; do
  # ── Read last price ────────────────────────────────────────────
  if [[ ! -f "$PRICE_FILE" ]]; then
    log "⚠  Price file '$PRICE_FILE' not found, skipping"
    sleep "$DELAY"
    continue
  fi

  price="$(cat "$PRICE_FILE" | tr -d '[:space:]')"
  if [[ -z "$price" ]]; then
    log "⚠  Price file is empty, skipping"
    sleep "$DELAY"
    continue
  fi

  # ── Stop-loss = price − $0.05 ──────────────────────────────────
  sl_price="$(python3 -c "print(max(0, round(float('$price') - 0.01, 2)))")"
  log "XTIUSDT: price=$price → stop-loss=\$${sl_price}"

  # ── Cancel existing stop-loss orders ──────────────────────────
  # ./scripts/phemex-cancel-orders-all.ts --symbol XTIUSDT --posSide Long \
  ./cancel-orders.rb   || log "⚠  Cancel orders failed"

  # ── Place stop-loss conditional order ──────────────────────────
  npx tsx "$CONDITIONAL" \
    --symbol XTIUSDT \
    --pos-side Long \
    --stop-loss "$sl_price" \
    --trigger-type ByLastPrice || log "⚠  Conditional order failed"

  echo
  log "Sleeping ${DELAY}s …"
  sleep "$DELAY"
  echo "──────────────────────────────────────────────"
done
