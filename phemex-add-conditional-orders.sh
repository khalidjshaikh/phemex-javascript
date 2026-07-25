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
ORDER_ID_FILE_XTI="xtiusdt-conditional-order-id.txt"
ORDER_ID_FILE_XBR="xbrusdt-conditional-order-id.txt"
CANCEL_ORDER="./phemex-cancel-order.ts"
CONDITIONAL="./phemex-add-conditional-orders.ts"
# ────────────────────────────────────────────────────────────────────

log() { echo "[$(date '+%F %T')] $*"; }

run_iteration() {
  local sym label price_file price sl_price order_id_file

#  for sym in XTIUSDT XBRUSDT; do
  for sym in XTIUSDT; do
    case "$sym" in
      XTIUSDT) label="XTI"; price_file="$PRICE_FILE_XTI"; order_id_file="$ORDER_ID_FILE_XTI" ;;
      XBRUSDT) label="XBR"; price_file="$PRICE_FILE_XBR"; order_id_file="$ORDER_ID_FILE_XBR" ;;
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

    # ── Cancel previous conditional order (not all orders) ────────
    if [[ -f "$order_id_file" ]]; then
      prev_id="$(cat "$order_id_file" | tr -d '[:space:]')"
      if [[ -n "$prev_id" ]]; then
        log "${label}: cancelling previous order ${prev_id} …"
        if ! npx tsx "$CANCEL_ORDER" --order-id "$prev_id" --symbol "$sym" --pos-side Long; then
          log "⚠ ${label}: cancel of previous order failed (may already be filled/cancelled)"
        fi
      fi
    fi

    # ── Place stop-loss conditional order ─────────────────────────
    log "${label}: placing stop-loss at \$${sl_price} …"
    conditional_output="$(npx tsx "$CONDITIONAL" \
      --symbol "$sym" \
      --stop-loss "$sl_price" \
      --pos-side Long \
      --trigger-type ByLastPrice 2>&1)" || true
    echo "$conditional_output"

    # ── Extract and store the new order ID ────────────────────────
    new_id="$(echo "$conditional_output" | sed -n 's/.*orderID=\([^)]*\).*/\1/p')"
    if [[ -n "$new_id" ]]; then
      echo "$new_id" > "$order_id_file"
      log "${label}: stored order ID ${new_id}"
    else
      log "⚠ ${label}: could not extract order ID from output"
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
