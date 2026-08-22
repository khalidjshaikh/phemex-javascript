#!/usr/bin/env python3
"""
Phemex Index Slope Tracker

Tracks the slope (rate of change) of index price over multiple windows using deque.
No trading - just prints slopes every tick for manual decision-making.

Usage:
  python3 phemex-river-trader3.py --symbol BTCUSDT --duration 0
"""

import argparse
import asyncio
import json
import sys
import time
from collections import deque
from datetime import datetime

import websockets


WS_URL = "wss://ws.phemex.com"
HEARTBEAT_INTERVAL = 20
WINDOWS = [1, 3, 10, 25, 50, 100, 200]


class SlopeTracker:
    """Tracks price and calculates slopes over multiple windows."""

    def __init__(self, windows):
        self.windows = windows
        self.max_window = max(windows)
        self.history = deque(maxlen=self.max_window + 1)

    def update(self, price):
        self.history.append(price)
        if len(self.history) < 2:
            return {w: 0.0 for w in self.windows}

        slopes = {}
        for w in self.windows:
            if len(self.history) > w:
                slopes[w] = (self.history[-1] - self.history[-1 - w]) / w
            else:
                slopes[w] = 0.0
        return slopes


def parse_args():
    p = argparse.ArgumentParser(description="Phemex price slope tracker")
    p.add_argument("--symbol", default="BTCUSDT", help="Trading pair (default: BTCUSDT)")
    p.add_argument("--duration", type=int, default=0, help="Run duration in seconds, 0=indefinite (default: 0)")
    p.add_argument("--decimals", type=int, default=4, help="Decimal places for index price (default: 4)")
    return p.parse_args()


def fmt(v, decimals=4):
    if v is None:
        return "—"
    return f"{v:.{decimals}f}"


def fmt_slope(v, decimals=4):
    if v is None:
        return "—"
    s = f"{v:+.{decimals}f}"
    return s


async def run():
    args = parse_args()
    symbol = args.symbol
    duration = args.duration

    tracker = SlopeTracker(WINDOWS)
    tick_count = 0
    cached_fields = None

    header = f"{'Time':>12} {'Index':>12}" + "".join(f" {'Slope'+str(w):>12}" for w in WINDOWS)
    print(header)
    print("-" * len(header))

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
                        print(f"\nDone: {tick_count} ticks in {duration}s")
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

                    index_price = data.get("indexRp")
                    if index_price is None:
                        continue

                    index_price = float(index_price)
                    tick_count += 1

                    slopes = tracker.update(index_price)

                    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                    slope_strs = "".join(f" {fmt_slope(slopes[w], args.decimals):>12}" for w in WINDOWS)

                    print(f"{ts:>12} {fmt(index_price, args.decimals):>12}{slope_strs}", flush=True)

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
