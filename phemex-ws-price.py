#!/usr/bin/env python3

"""
Phemex WebSocket Price — subscribes to the BTCUSD 24h ticker channel,
printing the last price to stdout on each update.

Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
Sends a heartbeat (server.ping) every 20s and prints the pong to stdout.

Usage:  ./phemex-ws-price.py
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


class PriceClient:
    def __init__(self):
        self._last_printed_price: float | None = None
        self._reconnect_delay = 1.0
        self._max_reconnect_delay = 30.0
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._running = True

    # ------------------------------------------------------------------
    #  Price output
    # ------------------------------------------------------------------

    def _log_price_if_changed(self, price: float) -> None:
        if self._last_printed_price is None or price != self._last_printed_price:
            now = datetime.now().strftime("%m/%d/%Y, %H:%M:%S")
            print(f"\n{now}  {price:.2f} ", end="", flush=True)
            self._last_printed_price = price

    # ------------------------------------------------------------------
    #  Connection logic
    # ------------------------------------------------------------------

    def _handle_message(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        # Pong — heartbeat response
        if msg.get("result") == "pong":
            print("♥", end="", flush=True)
            return

        if msg.get("error") is not None:
            print(f"Subscription error: {msg['error']}", file=sys.stderr)
            return

        # Ignore subscription ack
        if isinstance(msg.get("result"), dict) and msg["result"].get("status") == "success":
            return

        # 24h ticker channel — updates every 1s
        market24h = msg.get("market24h")
        if isinstance(market24h, dict) and market24h.get("symbol") == SYMBOL:
            close_ep = market24h.get("close")
            if close_ep is not None:
                price = close_ep / PRICE_SCALE
                self._log_price_if_changed(price)

    async def _heartbeat(self) -> None:
        """Send a ping every HEARTBEAT_INTERVAL seconds."""
        while self._running:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            if self._ws and self._ws.state.name == "OPEN":
                try:
                    await self._ws.send(
                        json.dumps({"method": "server.ping", "params": [], "id": int(datetime.now().timestamp() * 1000)})
                    )
                except websockets.ConnectionClosed:
                    break

    async def run(self) -> None:
        while self._running:
            try:
                async with websockets.connect(WS_URL, ping_interval=None) as ws:
                    self._ws = ws
                    self._reconnect_delay = 1.0  # reset backoff

                    # Subscribe to 24h ticker
                    await ws.send(
                        json.dumps({"method": "market24h.subscribe", "params": [], "id": 2})
                    )

                    # Start heartbeat task
                    heartbeat_task = asyncio.create_task(self._heartbeat())

                    # Read messages
                    async for raw in ws:
                        if not self._running:
                            break
                        self._handle_message(raw)

                    heartbeat_task.cancel()
                    try:
                        await heartbeat_task
                    except asyncio.CancelledError:
                        pass
            except websockets.ConnectionClosed:
                pass
            except OSError:
                pass

            if not self._running:
                break

            # Exponential backoff reconnect
            print(f"\n[reconnecting in {self._reconnect_delay:.0f}s...]", flush=True)
            await asyncio.sleep(self._reconnect_delay)
            self._reconnect_delay = min(self._reconnect_delay * 2, self._max_reconnect_delay)

    def stop(self) -> None:
        self._running = False


async def main() -> None:
    client = PriceClient()

    # Handle Ctrl+C gracefully
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGINT, client.stop)

    await client.run()


if __name__ == "__main__":
    asyncio.run(main())
