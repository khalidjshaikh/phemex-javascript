#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# cancel-all-open-orders.sh  —  List all open orders for a symbol,
#                               then cancel each one individually.
#
# Uses phemex-cli for both listing and cancelling.  Credentials must be
# available via environment variables (PHEMEX_API_KEY, PHEMEX_API_SECRET,
# PHEMEX_API_URL) or the credentials file (.phemex-credentials.json).
#
# Usage:
#   ./cancel-all-open-orders.sh [symbol] [posSide]
#
# Examples:
#   ./cancel-all-open-orders.sh                         # XTIUSDT, Long
#   ./cancel-all-open-orders.sh XTIUSDT Long
#   ./cancel-all-open-orders.sh BTCUSDT Short
#
# Requires: phemex-cli, python3 (for JSON parsing)

set -euo pipefail

cd "$(dirname "$0")"

# ── Config ──────────────────────────────────────────────────────────
SYMBOL="${1:-XTIUSDT}"
POS_SIDE="${2:-Long}"
# ────────────────────────────────────────────────────────────────────

log()   { echo "[$(date '+%F %T')] $*"; }
die()   { log "✗ $*"; exit 1; }

# ── 1. Fetch open orders as JSON ────────────────────────────────────
log "Fetching open orders for ${SYMBOL} …"
# stdout mixes a log line + JSON; stderr has nothing useful,
# so extract just the JSON object (first line starting with '{').
ORDER_IDS="$(
  ./phemex-cli get_open_orders --symbol "$SYMBOL" --json 2>/dev/null \
    | python3 -c "
import json, sys

# Find first valid JSON object in the input (skips non-JSON log lines)
raw = sys.stdin.read()
for line in raw.splitlines():
    line = line.strip()
    if line.startswith('{'):
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        orders = data.get('orders') or data.get('rows') or []
        for o in orders:
            oid = o.get('orderID', '').strip()
            if oid:
                print(oid)
        if not orders:
            print('__NO_ORDERS__')
        break
" || true
)"

if [[ "$ORDER_IDS" == "__NO_ORDERS__" || -z "$ORDER_IDS" ]]; then
  log "No open orders for ${SYMBOL} to cancel."
  exit 0
fi

# Count them
COUNT="$(echo "$ORDER_IDS" | wc -l | tr -d ' ')"
log "Found ${COUNT} open order(s)."

# ── 3. Cancel each order ───────────────────────────────────────────
CANCELLED=0
FAILED=0

while IFS= read -r OID; do
  [[ -z "$OID" ]] && continue
  log "Cancelling ${OID} …"
  if OUTPUT="$(./phemex-cli cancel_order --symbol "$SYMBOL" --orderID "$OID" --posSide "$POS_SIDE" 2>&1)"; then
    echo "$OUTPUT"
    ((CANCELLED++))
  else
    echo "$OUTPUT"
    log "⚠  Failed to cancel ${OID}"
    ((FAILED++))
  fi
done <<< "$ORDER_IDS"

# ── Summary ─────────────────────────────────────────────────────────
echo
log "Done — ${CANCELLED} cancelled, ${FAILED} failed."
