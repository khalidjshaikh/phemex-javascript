#!/bin/bash
# scripts/xtiusdt-compound-trader.ts --restore "$@" 2>&1 | tee -a "trader-$(date '+%Y-%m-%d_%H-%M-%S').log"
#npx tsx scripts/phemex-ws-auto-trader2.ts "$@" --symbol XTIUSDT,XBRUSDT,XAUUSDT | tee -a "logs/trader-$(date '+%Y-%m-%d_%H-%M-%S').log"
scripts/phemex-ws-auto-trader2.ts --error-budget 1 "$@" --symbol BNBUSDT,BTCUSDT,DOGEUSDT,ETHUSDT,LINKUSDT,SOLUSDT,SUIUSDT,XAUUSDT,XBRUSDT,XRPUSDT,XTIUSDT --credential meta --configfile config/gm.json5 | tee -a "logs/trader-$(date '+%Y-%m-%d_%H-%M-%S').log"

