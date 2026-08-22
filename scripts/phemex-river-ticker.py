#!/usr/bin/env python3
"""
Phemex WebSocket Ticker — streams BTCUSDT last/index prices
and computes rate of movement per tick using streaming statistics.

Usage:
  python3 phemex-river-ticker.py --symbol BTCUSDT --duration 10
"""

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime

import websockets


WS_URL = "wss://ws.phemex.com"
HEARTBEAT_INTERVAL = 20


class StreamingStats:
    """Online mean and variance using Welford's algorithm."""

    def __init__(self):
        self.n = 0
        self.mean = 0.0
        self.M2 = 0.0

    def update(self, value):
        self.n += 1
        delta = value - self.mean
        self.mean += delta / self.n
        delta2 = value - self.mean
        self.M2 += delta * delta2

    @property
    def variance(self):
        return self.M2 / self.n if self.n > 1 else 0.0

    @property
    def count(self):
        return self.n


def parse_args():
    p = argparse.ArgumentParser(description="Phemex ticker with streaming stats")
    p.add_argument("--symbol", default="BTCUSDT", help="Trading pair (default: BTCUSDT)")
    p.add_argument("--duration", type=int, default=0, help="Run duration in seconds, 0=indefinite (default: 0)")
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

    # Streaming stats for rate tracking
    last_stats = StreamingStats()
    index_stats = StreamingStats()
    spread_stats = StreamingStats()
    rate_last_stats = StreamingStats()
    rate_index_stats = StreamingStats()

    prev_last = None
    prev_index = None
    prev_time = None
    tick_count = 0
    cached_fields = None

    print(f"{'Time':>12} {'Last':>12} {'Index':>12} {'I-L':>12} {'ΔLast/tick':>12} {'ΔIndex/tick':>12}")
    print("-" * 80)

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
                        print("\n" + "=" * 80)
                        print(f"SUMMARY after {duration}s ({tick_count} ticks)")
                        print("=" * 80)
                        print(f"  Last price:  mean={fmt(last_stats.mean)}, variance={fmt(last_stats.variance, 6)}")
                        print(f"  Index price: mean={fmt(index_stats.mean)}, variance={fmt(index_stats.variance, 6)}")
                        print(f"  I-L (index-last): mean={fmt(spread_stats.mean)}")
                        print(f"  Rate Last/tick:  {fmt(rate_last_stats.mean)} $/tick (n={rate_last_stats.count})")
                        print(f"  Rate Index/tick: {fmt(rate_index_stats.mean)} $/tick (n={rate_index_stats.count})")
                        print("=" * 80)
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

                    delta_last = None
                    delta_index = None
                    if prev_last is not None and prev_time is not None:
                        dt = now - prev_time
                        if dt > 0:
                            delta_last = last_price - prev_last
                            delta_index = index_price - prev_index

                            last_stats.update(delta_last)
                            index_stats.update(delta_index)
                            rate_last_stats.update(delta_last)
                            rate_index_stats.update(delta_index)

                    spread = index_price - last_price
                    spread_stats.update(spread)

                    ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                    d_last = fmt_delta(delta_last) if delta_last is not None else "—"
                    d_index = fmt_delta(delta_index) if delta_index is not None else "—"

                    print(
                        f"{ts:>12} {fmt(last_price):>12} {fmt(index_price):>12} "
                        f"{fmt_delta(spread):>12} {d_last:>12} {d_index:>12}",
                        flush=True,
                    )

                    prev_last = last_price
                    prev_index = index_price
                    prev_time = now

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
