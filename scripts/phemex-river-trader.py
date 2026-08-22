#!/usr/bin/env python3
"""
Phemex Mean-Reversion Trading Prototype

Uses River to track spread z-scores and generate long/short signals.
100x leverage, 0.06% fee per trade.

Usage:
  python3 phemex-river-trader.py --symbol BTCUSDT --duration 0
"""

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime

import websockets
from river import stats


WS_URL = "wss://ws.phemex.com"
HEARTBEAT_INTERVAL = 20
LEVERAGE = 100
FEE_RATE = 0.0006  # 0.06% per trade


class SpreadTracker:
    """Tracks spread z-score using River online stats."""

    def __init__(self, lookback=100):
        self.mean = stats.Mean()
        self.var = stats.Var()
        self.lookback = lookback
        self.history = []

    def update(self, spread):
        self.mean.update(spread)
        self.var.update(spread)
        self.history.append(spread)
        if len(self.history) > self.lookback:
            self.history.pop(0)

    @property
    def current_mean(self):
        return self.mean.get()

    @property
    def current_std(self):
        v = self.var.get()
        return v ** 0.5 if v > 0 else 0.0

    def z_score(self, spread):
        std = self.current_std
        if std < 1e-10:
            return 0.0
        return (spread - self.current_mean) / std


class Position:
    """Tracks open position and P&L."""

    def __init__(self):
        self.side = None  # 'long' or 'short'
        self.entry_price = 0.0
        self.entry_time = None
        self.size_usd = 0.0

    @property
    def is_open(self):
        return self.side is not None

    def open(self, side, price, capital):
        self.side = side
        self.entry_price = price
        self.entry_time = time.time()
        self.size_usd = capital * LEVERAGE

    def close(self, price):
        if not self.is_open:
            return 0.0

        if self.side == 'long':
            pnl_pct = (price - self.entry_price) / self.entry_price
        else:
            pnl_pct = (self.entry_price - price) / self.entry_price

        # Fees: open + close
        total_fee = FEE_RATE * 2
        pnl_pct -= total_fee

        pnl_usd = pnl_pct * self.size_usd
        self.side = None
        return pnl_usd


def parse_args():
    p = argparse.ArgumentParser(description="Phemex mean-reversion trader")
    p.add_argument("--symbol", default="BTCUSDT", help="Trading pair (default: BTCUSDT)")
    p.add_argument("--duration", type=int, default=0, help="Run duration in seconds, 0=indefinite (default: 0)")
    p.add_argument("--capital", type=float, default=1000, help="Starting capital in USD (default: 1000)")
    p.add_argument("--z-entry", type=float, default=2.0, help="Z-score threshold to open (default: 2.0)")
    p.add_argument("--z-exit", type=float, default=0.5, help="Z-score threshold to close (default: 0.5)")
    p.add_argument("--lookback", type=int, default=100, help="Spread history lookback (default: 100)")
    return p.parse_args()


def fmt(v, decimals=2):
    if v is None:
        return "—"
    return f"{v:.{decimals}f}"


def fmt_delta(v, decimals=2):
    if v is None:
        return "—"
    s = f"{v:.{decimals}f}"
    return f"+{s}" if v > 0 else s


async def run():
    args = parse_args()
    symbol = args.symbol
    duration = args.duration
    capital = args.capital
    z_entry = args.z_entry
    z_exit = args.z_exit

    tracker = SpreadTracker(lookback=args.lookback)
    position = Position()
    total_pnl = 0.0
    trades = []
    prev_last = None
    prev_index = None
    tick_count = 0
    cached_fields = None

    print(f"{'Time':>12} {'Last':>12} {'Index':>12} {'I-L':>12} {'Z':>8} {'Signal':>8} {'Pos':>6} {'P&L':>12}")
    print("-" * 96)

    t_start = time.time()

    while True:
        try:
            async with websockets.connect(WS_URL, ping_interval=None) as ws:
                sub = json.dumps({
                    "method": "perp_market24h_pack_p.subscribe",
                    "params": [],
                    "id": 1,
                })
                await ws.send(sub)

                async def heartbeat():
                    while True:
                        await asyncio.sleep(HEARTBEAT_INTERVAL)
                        try:
                            await ws.send(json.dumps({
                                "method": "server.ping",
                                "params": [],
                                "id": int(time.time() * 1000),
                            }))
                        except Exception:
                            break

                hb = asyncio.create_task(heartbeat())

                async for raw in ws:
                    now = time.time()
                    elapsed = now - t_start

                    if duration > 0 and elapsed >= duration:
                        hb.cancel()
                        if position.is_open:
                            # Force close at last known price
                            pass  # will be handled below
                        print("\n" + "=" * 96)
                        print(f"SUMMARY after {duration}s ({tick_count} ticks, {len(trades)} trades)")
                        print("=" * 96)
                        print(f"  Starting capital: ${capital:.2f}")
                        print(f"  Final P&L:        ${total_pnl:.2f}")
                        print(f"  Return:           {total_pnl/capital*100:.2f}%")
                        print(f"  Win rate:         {sum(1 for t in trades if t > 0)/len(trades)*100:.1f}%" if trades else "  Win rate: N/A")
                        print("=" * 96)
                        return

                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    if msg.get("result") == "pong":
                        continue

                    data = None
                    if msg.get("method") == "market24h_p.update" and msg.get("data"):
                        d = msg["data"]
                        if d.get("symbol") == symbol:
                            data = d
                    elif msg.get("method") == "perp_market24h_pack_p.update":
                        fields = msg.get("fields", [])
                        if fields:
                            cached_fields = fields
                        rows = msg.get("data", [])
                        if cached_fields and rows:
                            idx_sym = cached_fields.index("symbol") if "symbol" in cached_fields else -1
                            for row in rows:
                                if idx_sym >= 0 and row[idx_sym] == symbol:
                                    data = {f: row[i] for i, f in enumerate(cached_fields)}
                                    break

                    if data is None:
                        continue

                    last_price = data.get("lastRp")
                    index_price = data.get("indexRp")

                    if last_price is None or index_price is None:
                        continue

                    last_price = float(last_price)
                    index_price = float(index_price)
                    tick_count += 1

                    spread = index_price - last_price
                    tracker.update(spread)
                    z = tracker.z_score(spread)

                    # Signal logic
                    signal = "—"
                    if not position.is_open:
                        if z < -z_entry:
                            position.open('long', last_price, capital)
                            signal = "OPEN LONG"
                        elif z > z_entry:
                            position.open('short', last_price, capital)
                            signal = "OPEN SHORT"
                    else:
                        # Exit when spread reverts toward mean
                        if position.side == 'long' and z > -z_exit:
                            pnl = position.close(last_price)
                            total_pnl += pnl
                            trades.append(pnl)
                            signal = "CLOSE LONG"
                        elif position.side == 'short' and z < z_exit:
                            pnl = position.close(last_price)
                            total_pnl += pnl
                            trades.append(pnl)
                            signal = "CLOSE SHORT"

                    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                    pos_str = f"{position.side[0].upper()}" if position.is_open else "—"
                    pnl_str = f"${total_pnl:+.2f}"

                    print(
                        f"{ts:>12} {fmt(last_price):>12} {fmt(index_price):>12} "
                        f"{fmt_delta(spread):>12} {z:>8.2f} {signal:>8} {pos_str:>6} {pnl_str:>12}",
                        flush=True,
                    )

                    prev_last = last_price
                    prev_index = index_price

                hb.cancel()
                break

        except (websockets.ConnectionClosed, OSError) as exc:
            print(f"\nConnection lost ({exc}). Reconnecting in 2s...", file=sys.stderr)
            await asyncio.sleep(2)


def main():
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nShutting down.")
        sys.exit(0)


if __name__ == "__main__":
    main()
