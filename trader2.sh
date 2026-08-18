#!/bin/bash
scripts/phemex-ws-auto-trader2.ts "$@" --symbol BNBUSDT,BTCUSDT,DOGEUSDT,ETHUSDT,LINKUSDT,SOLUSDT,SUIUSDT,XAUUSDT,XBRUSDT,XRPUSDT,XTIUSDT --credential A02 --configfile config/config.json5| tee -a "logs2/trader-$(date '+%Y-%m-%d_%H-%M-%S').log"
