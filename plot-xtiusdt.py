#!/usr/bin/env python3
"""
Real-time ticker plotter for XTIUSDT.

Tails xtiusdt-ticks.log and renders 3 vertically-stacked plots:
  1. Price ($) vs Time
  2. 1st derivative (dP/dt, $/s) vs Time
  3. 2nd derivative (d²P/dt², $/s²) vs Time

Usage:
  python3 plot-xtiusdt.py
"""

import os
import re
import sys
import time
from collections import deque
from datetime import datetime

import matplotlib
matplotlib.use("TkAgg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

LOG_FILE = "xtiusdt-ticks.log"
MAX_POINTS = 500  # rolling window of data points
ZOOM_STEP = 1.5  # multiplier per +/- key press


# ── Log-line parser ──────────────────────────────────────────────────

def parse_line(line: str):
    """Parse a log line, return (datetime, price) or None."""
    m = re.match(
        r"(\d{1,2}/\d{1,2}/\d{4}),\s*(\d{1,2}:\d{2}:\d{2}\s*[APap][Mm])",
        line,
    )
    if not m:
        return None
    dt_str = f"{m.group(1)} {m.group(2)}"
    try:
        dt = datetime.strptime(dt_str, "%m/%d/%Y %I:%M:%S %p")
    except ValueError:
        return None

    # Price: $XX.XX anywhere on the line
    price_m = re.search(r"\$(\d+\.\d+)", line)
    if not price_m:
        return None
    return dt, float(price_m.group(1))


# ── File tailing ─────────────────────────────────────────────────────

def follow(filepath: str, fig):
    """Yield new lines appended to a file (poll-based, cross-platform)."""
    with open(filepath, "r") as f:
        f.seek(0, os.SEEK_END)  # skip existing content in tail mode
        while True:
            line = f.readline()
            if line:
                yield line
            else:
                # Lightweight event processing — no full redraw
                fig.canvas.flush_events()
                time.sleep(0.1)


# ── Plot setup ───────────────────────────────────────────────────────

def setup_figure():
    """Create interactive figure with 3 subplots, return handles."""
    plt.ion()
    fig, (ax1, ax2, ax3) = plt.subplots(3, 1, figsize=(12, 9), sharex=True)
    fig.canvas.manager.set_window_title("XTIUSDT — Live Ticker")

    (line1,) = ax1.plot([], [], "b-", lw=1.5, marker="o", ms=6, label="Price")
    ax1.set_ylabel("Price ($)")
    ax1.grid(True, alpha=0.3)
    ax1.legend(loc="upper left")
    ax1.set_title("XTIUSDT Price")

    (line2,) = ax2.plot([], [], "g-", lw=1.5, marker="o", ms=6, label="dP/dt")
    ax2.axhline(y=0, color="gray", lw=0.5)
    ax2.set_ylabel("dP/dt ($/s)")
    ax2.grid(True, alpha=0.3)
    ax2.legend(loc="upper left")
    ax2.set_title("1st Derivative — Rate of Change")

    (line3,) = ax3.plot([], [], "r-", lw=1.5, marker="o", ms=6, label="d²P/dt²")
    ax3.axhline(y=0, color="gray", lw=0.5)
    ax3.set_ylabel("d²P/dt² ($/s²)")
    ax3.set_xlabel("Time")
    ax3.grid(True, alpha=0.3)
    ax3.legend(loc="upper left")
    ax3.set_title("2nd Derivative — Acceleration")

    fig.tight_layout()
    return fig, ax1, ax2, ax3, line1, line2, line3


# ── Derivatives ──────────────────────────────────────────────────────

def derivatives(times, prices):
    """
    Return (d1, d1_times, d2, d2_times).

    d1[i] = (p[i+1]-p[i])/(t[i+1]-t[i])  aligned at t[i+1]
    d2[i] = (d1[i+1]-d1[i])/(t[i+2]-t[i+1]) aligned at t[i+2]
    """
    n = len(prices)
    if n < 2:
        return [], [], [], []

    # 1st derivative
    d1 = []
    d1_times = []
    for i in range(1, n):
        dt_sec = (times[i] - times[i - 1]).total_seconds()
        if dt_sec <= 0:
            continue
        d1.append((prices[i] - prices[i - 1]) / dt_sec)
        d1_times.append(times[i])

    if len(d1) < 2:
        return d1, d1_times, [], []

    # 2nd derivative
    d2 = []
    d2_times = []
    for i in range(1, len(d1)):
        dt_sec = (d1_times[i] - d1_times[i - 1]).total_seconds()
        if dt_sec <= 0:
            continue
        d2.append((d1[i] - d1[i - 1]) / dt_sec)
        d2_times.append(d1_times[i])

    return d1, d1_times, d2, d2_times


# ── Plot update ──────────────────────────────────────────────────────

def update_plot(fig, ax1, ax2, ax3, l1, l2, l3, times, prices,
                d1, d1_t, d2, d2_t, zoom_level=1.0,
                pan_x=0.0, pan_y=0.0):
    """Redraw all three subplots, applying zoom and pan offsets."""
    l1.set_data(times, prices)

    # Convert time to numeric, compute base center + pan offset
    t0 = mdates.date2num(times[0])
    t1 = mdates.date2num(times[-1])
    data_center = (t0 + t1) / 2
    t_half = (t1 - t0) / 2
    t_range = t_half / zoom_level if zoom_level > 0 else t_half
    t_center = data_center + pan_x * t_range
    ax1.set_xlim(mdates.num2date(t_center - t_range),
                 mdates.num2date(t_center + t_range))

    margin1 = (max(prices) - min(prices)) * 0.15 or 0.5
    p_data_center = (max(prices) + min(prices)) / 2
    p_half = (max(prices) - min(prices)) / 2 + margin1
    p_range = p_half / zoom_level if zoom_level > 0 else p_half
    p_center = p_data_center + pan_y * p_range
    ax1.set_ylim(p_center - p_range, p_center + p_range)

    if d1:
        l2.set_data(d1_t, d1)
        ax2.set_xlim(mdates.num2date(t_center - t_range),
                     mdates.num2date(t_center + t_range))
        lo, hi = min(d1), max(d1)
        margin2 = (hi - lo) * 0.2 or 0.1
        d1_center = (lo + hi) / 2
        d1_half = (hi - lo) / 2 + margin2
        d1_range = d1_half / zoom_level if zoom_level > 0 else d1_half
        ax2.set_ylim(d1_center - d1_range, d1_center + d1_range)
    else:
        l2.set_data([], [])

    if d2:
        l3.set_data(d2_t, d2)
        ax3.set_xlim(mdates.num2date(t_center - t_range),
                     mdates.num2date(t_center + t_range))
        lo, hi = min(d2), max(d2)
        margin3 = (hi - lo) * 0.2 or 0.1
        d2_center = (lo + hi) / 2
        d2_half = (hi - lo) / 2 + margin3
        d2_range = d2_half / zoom_level if zoom_level > 0 else d2_half
        ax3.set_ylim(d2_center - d2_range, d2_center + d2_range)
    else:
        l3.set_data([], [])

    # Format x-axis
    for ax in (ax1, ax2, ax3):
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M:%S"))
        ax.xaxis.set_major_locator(mdates.AutoDateLocator())

    fig.canvas.draw_idle()
    fig.canvas.flush_events()


# ── Main ─────────────────────────────────────────────────────────────

def main():
    if not os.path.exists(LOG_FILE):
        print(f"Error: {LOG_FILE} not found", file=sys.stderr)
        sys.exit(1)

    fig, ax1, ax2, ax3, l1, l2, l3 = setup_figure()

    # Keep the window behind other apps on macOS
    fig.canvas.manager.window.lower()

    # ── Zoom / pan state ────────────────────────────────────────────────
    zoom_state = [1.0]   # 1.0 = fit all data
    pan_x = [0.0]        # fractional offset of current view width
    pan_y = [0.0]        # fractional offset of current view height
    PAN_STEP = 0.25      # fraction of visible range per arrow press

    def on_key(event):
        print(f"[debug] key pressed: {event.key!r}")
        changed = False
        if event.key in ("+", "=", "add"):
            zoom_state[0] = min(zoom_state[0] * ZOOM_STEP, 50.0)
            print(f"[zoom] in → {zoom_state[0]:.2f}x")
            changed = True
        elif event.key in ("-", "_", "subtract"):
            zoom_state[0] = max(zoom_state[0] / ZOOM_STEP, 0.05)
            print(f"[zoom] out → {zoom_state[0]:.2f}x")
            changed = True
        elif event.key in ("r", "R"):
            zoom_state[0] = 1.0
            pan_x[0] = 0.0
            pan_y[0] = 0.0
            print("[zoom/pan] reset")
            changed = True
        elif event.key == "left":
            pan_x[0] -= PAN_STEP
            print(f"[pan] left → x={pan_x[0]:.2f}")
            changed = True
        elif event.key == "right":
            pan_x[0] += PAN_STEP
            print(f"[pan] right → x={pan_x[0]:.2f}")
            changed = True
        elif event.key == "up":
            pan_y[0] += PAN_STEP
            print(f"[pan] up → y={pan_y[0]:.2f}")
            changed = True
        elif event.key == "down":
            pan_y[0] -= PAN_STEP
            print(f"[pan] down → y={pan_y[0]:.2f}")
            changed = True

        if changed and len(times) >= 2:
            t_list = list(times)
            p_list = list(prices)
            d1, d1_t, d2, d2_t = derivatives(t_list, p_list)
            update_plot(fig, ax1, ax2, ax3, l1, l2, l3,
                        t_list, p_list, d1, d1_t, d2, d2_t,
                        zoom_level=zoom_state[0],
                        pan_x=pan_x[0], pan_y=pan_y[0])

    fig.canvas.mpl_connect("key_press_event", on_key)

    times: deque = deque(maxlen=MAX_POINTS)
    prices: deque = deque(maxlen=MAX_POINTS)

    # ── Phase 1: read all existing lines, then plot once ──────────────
    print(f"Reading existing data from {LOG_FILE} …")
    with open(LOG_FILE, "r") as f:
        existing = f.readlines()

    for line in existing:
        parsed = parse_line(line)
        if parsed is None:
            continue
        dt, price = parsed
        times.append(dt)
        prices.append(price)

    if len(times) >= 2:
        t_list = list(times)
        p_list = list(prices)
        d1, d1_t, d2, d2_t = derivatives(t_list, p_list)
        update_plot(fig, ax1, ax2, ax3, l1, l2, l3,
                    t_list, p_list, d1, d1_t, d2, d2_t,
                    zoom_level=zoom_state[0],
                    pan_x=pan_x[0], pan_y=pan_y[0])
        plt.pause(0.05)
        print(f"Loaded {len(times)} ticks.")

    # ── Phase 2: tail for new lines ───────────────────────────────────
    print("Tailing for new ticks …  (Ctrl+C to stop)")
    last_plot = 0.0
    try:
        for new_line in follow(LOG_FILE, fig):
            parsed = parse_line(new_line)
            if parsed is None:
                continue
            dt, price = parsed
            times.append(dt)
            prices.append(price)
            if len(times) < 2:
                fig.canvas.flush_events()
                continue

            now = time.monotonic()
            if now - last_plot >= 0.12:          # throttle: max ~8 fps
                last_plot = now
                t_list = list(times)
                p_list = list(prices)
                d1, d1_t, d2, d2_t = derivatives(t_list, p_list)
                update_plot(fig, ax1, ax2, ax3, l1, l2, l3,
                            t_list, p_list, d1, d1_t, d2, d2_t,
                            zoom_level=zoom_state[0],
                            pan_x=pan_x[0], pan_y=pan_y[0])
            else:
                # Keep the window responsive between throttled redraws
                fig.canvas.flush_events()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        plt.ioff()
        plt.show(block=True)


if __name__ == "__main__":
    main()
