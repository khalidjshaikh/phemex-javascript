#!/usr/bin/env bash
scripts/phemex-ws-auto-trader2.ts --no-reversal-exit "$@" --symbols BNBUSDT,BTCUSDT,DOGEUSDT,ETHUSDT,LINKUSDT,SOLUSDT,SUIUSDT,XAUUSDT,XBRUSDT,XRPUSDT,XTIUSDT --credential 67b --configfile config/67b.json5 --no-ticker-logs | tee -a "logs2/trader-$(date '+%Y-%m-%d_%H-%M-%S').log"
