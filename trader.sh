#!/bin/bash
# scripts/xtiusdt-compound-trader.ts --restore "$@" 2>&1 | tee -a "trader-$(date '+%Y-%m-%d_%H-%M-%S').log"
npx tsx scripts/phemex-ws-auto-trader.ts "$@" --qty 0.01 | tee -a "trader-$(date '+%Y-%m-%d_%H-%M-%S').log"
