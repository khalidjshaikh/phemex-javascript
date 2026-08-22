#!/usr/bin/env python3
"""Debug: print raw WebSocket messages from Phemex."""
import asyncio
import json
import time
import websockets

WS_URL = "wss://ws.phemex.com"

async def run():
    t_start = time.time()
    async with websockets.connect(WS_URL, ping_interval=None) as ws:
        await ws.send(json.dumps({
            "method": "perp_market24h_pack_p.subscribe",
            "params": [],
            "id": 1,
        }))
        async for raw in ws:
            now = time.time()
            if now - t_start > 15:
                break
            msg = json.loads(raw)
            method = msg.get("method", "")
            if method:
                print(f"[{now - t_start:.1f}s] method={method} fields={len(msg.get('fields',[]))} rows={len(msg.get('data',[]))}")
            elif msg.get("id") == 1:
                print(f"[{now - t_start:.1f}s] SUBSCRIBED: {msg}")
            elif msg.get("result") == "pong":
                pass
            else:
                print(f"[{now - t_start:.1f}s] other: {list(msg.keys())[:5]}")

asyncio.run(run())
