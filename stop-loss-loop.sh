#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# stop-loss-loop.sh  —  Infinite loop that reads last-price files, calculates
#                        stop-loss at current price − $0.05, cancels all orders,
#                        then places a reduce-only stop-loss order for both
#                        XTIUSDT and XBRUSDT (Long side).
#
# Usage:
#   ./stop-loss-loop.sh [delay_seconds]
#
# Default delay between iterations: 60 seconds.
# Press Ctrl-C to stop.

set -euo pipefail

cd "$(dirname "$0")"

# ── Config ──────────────────────────────────────────────────────────
DELAY="${1:-60}"                     # seconds between loop iterations
PRICE_FILE_XTI="xtiusdt-last-price.txt"
PRICE_FILE_XBR="xbrusdt-last-price.txt"
CANCEL="./phemex-cancel-orders-all.ts"
CONDITIONAL="./phemex-add-conditional-orders.ts"
# ────────────────────────────────────────────────────────────────────

log() { echo "[$(date '+%F %T')] $*"; }

run_iteration() {
  local sym label price_file price sl_price

  for sym in XTIUSDT XBRUSDT; do
    case "$sym" in
      XTIUSDT) label="XTI"; price_file="$PRICE_FILE_XTI" ;;
      XBRUSDT) label="XBR"; price_file="$PRICE_FILE_XBR" ;;
    esac

    # ── Read last price ──────────────────────────────────────────
    if [[ ! -f "$price_file" ]]; then
      log "⚠ ${label}: price file '$price_file' not found, skipping"
      continue
    fi

    price="$(cat "$price_file" | tr -d '[:space:]')"
    if [[ -z "$price" ]]; then
      log "⚠ ${label}: price file is empty, skipping"
      continue
    fi

    # ── Stop-loss = price − $0.05 ────────────────────────────────
    sl_price="$(python3 -c "print(max(0, round(float('$price') - 0.05, 2)))")"
    log "${label}: price=$price → stop-loss=\$${sl_price}"

    # ── Cancel all orders ────────────────────────────────────────
    log "${label}: cancelling all orders …"
    if ! npx tsx "$CANCEL" --symbol "$sym" --posSide Long; then
      log "⚠ ${label}: cancel step failed, continuing"
    fi

    # ── Place stop-loss conditional order ─────────────────────────
    log "${label}: placing stop-loss at \$${sl_price} …"
    if ! npx tsx "$CONDITIONAL" \
      --symbol "$sym" \
      --stop-loss "$sl_price" \
      --pos-side Long \
      --trigger-type ByLastPrice; then
      log "⚠ ${label}: conditional order step failed, continuing"
    fi

    echo
  done
}

# ── Main loop ───────────────────────────────────────────────────────
log "stop-loss-loop started (delay=${DELAY}s)"
log "Press Ctrl-C to stop."
echo

while true; do
  run_iteration
  log "Sleeping ${DELAY}s …"
  sleep "$DELAY"
  echo "──────────────────────────────────────────────"
done
