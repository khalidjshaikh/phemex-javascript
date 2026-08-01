#!/usr/bin/env python3
"""
Phemex WebSocket Ticker — subscribes to the BTCUSD 24h market ticker and
prints price, high, low, change %, and volume on each update.

Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
Sends a heartbeat (ping) every 20s and prints a heart symbol on pong.

Usage:  python3 ticker.py
"""

import asyncio
import json
import signal
import sys
from datetime import datetime

import websockets

WS_URL = "wss://ws.phemex.com"
SYMBOL = "BTCUSD"
PRICE_SCALE = 10_000
HEARTBEAT_INTERVAL = 20  # seconds


# ---------------------------------------------------------------------------
# Ticker display
# ---------------------------------------------------------------------------

_last_price: float | None = None


def print_ticker(msg: dict) -> None:
    """Print a formatted ticker line from a market24h update message."""
    global _last_price

    fields = msg.get("market24h", {})
    if fields.get("symbol") != SYMBOL:
        return

    close_ep = fields.get("close", 0)
    open_ep = fields.get("open", 0)
    high_ep = fields.get("high", 0)
    low_ep = fields.get("low", 0)
    volume = fields.get("volume", 0)

    last = close_ep / PRICE_SCALE
    open_ = open_ep / PRICE_SCALE
    high = high_ep / PRICE_SCALE
    low = low_ep / PRICE_SCALE

    if _last_price is not None and last == _last_price:
        return  # skip unchanged price

    change_pct = ((last - open_) / open_) * 100 if open_ > 0 else 0.0
    sign = "+" if change_pct >= 0 else ""

    now = datetime.now().strftime("%m/%d/%Y, %I:%M:%S %p")
    vol_str = f"{volume:,.0f}"
    line = (
        f"{now}  {SYMBOL}  ${last:.2f}  "
        f"H: ${high:.2f}  L: ${low:.2f}  "
        f"Chg: {sign}{change_pct:.2f}%  Vol: {vol_str}"
    )
    print(line, flush=True)
    _last_price = last


# ---------------------------------------------------------------------------
# WebSocket client
# ---------------------------------------------------------------------------

_reconnect_delay = 1  # seconds, starts at 1s
MAX_RECONNECT_DELAY = 30  # seconds


async def run() -> None:
    """Connect, subscribe, and process messages, with auto-reconnect."""
    global _reconnect_delay

    while True:
        try:
            async with websockets.connect(WS_URL, ping_interval=None) as ws:
                _reconnect_delay = 1  # reset backoff on successful connect

                # Subscribe to 24h ticker channel
                subscribe_msg = json.dumps(
                    {"method": "market24h.subscribe", "params": [], "id": 2}
                )
                await ws.send(subscribe_msg)

                # Heartbeat task
                async def heartbeat():
                    while True:
                        await asyncio.sleep(HEARTBEAT_INTERVAL)
                        try:
                            await ws.send(
                                json.dumps(
                                    {
                                        "method": "server.ping",
                                        "params": [],
                                        "id": int(datetime.now().timestamp() * 1000),
                                    }
                                )
                            )
                        except websockets.ConnectionClosed:
                            break

                hb_task = asyncio.create_task(heartbeat())

                # Message loop
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    # Pong — heartbeat response
                    if msg.get("result") == "pong":
                        print("♥", end="", flush=True)
                        continue

                    # Subscription error
                    if msg.get("error") is not None:
                        print(f"Subscription error: {msg['error']}", file=sys.stderr)
                        continue

                    # Subscription ack — ignore
                    result = msg.get("result")
                    if isinstance(result, dict) and result.get("status") == "success":
                        continue

                    # 24h ticker update
                    if "market24h" in msg:
                        print_ticker(msg)

                hb_task.cancel()
                break  # clean disconnect, don't reconnect

        except (websockets.ConnectionClosed, OSError) as exc:
            print(
                f"\nConnection lost ({exc}). Reconnecting in {_reconnect_delay}s...",
                file=sys.stderr,
            )
            await asyncio.sleep(_reconnect_delay)
            _reconnect_delay = min(_reconnect_delay * 2, MAX_RECONNECT_DELAY)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nShutting down.")
        sys.exit(0)


if __name__ == "__main__":
    main()