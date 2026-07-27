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
from collections import deque
from datetime import datetime

import matplotlib
matplotlib.use("TkAgg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

LOG_FILE = "xtiusdt-ticks.log"
MAX_POINTS = 500  # rolling window of data points


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

def follow(filepath: str):
    """Yield new lines appended to a file (poll-based, cross-platform)."""
    with open(filepath, "r") as f:
        f.seek(0, os.SEEK_END)  # skip existing content in tail mode
        while True:
            line = f.readline()
            if line:
                yield line
            else:
                # Process GUI events while waiting so the window stays alive
                plt.pause(0.2)


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
                d1, d1_t, d2, d2_t):
    """Redraw all three subplots."""
    l1.set_data(times, prices)
    ax1.set_xlim(times[0], times[-1])
    margin1 = (max(prices) - min(prices)) * 0.15 or 0.5
    ax1.set_ylim(min(prices) - margin1, max(prices) + margin1)

    if d1:
        l2.set_data(d1_t, d1)
        ax2.set_xlim(times[0], times[-1])
        lo, hi = min(d1), max(d1)
        margin2 = (hi - lo) * 0.2 or 0.1
        ax2.set_ylim(lo - margin2, hi + margin2)
    else:
        l2.set_data([], [])

    if d2:
        l3.set_data(d2_t, d2)
        ax3.set_xlim(times[0], times[-1])
        lo, hi = min(d2), max(d2)
        margin3 = (hi - lo) * 0.2 or 0.1
        ax3.set_ylim(lo - margin3, hi + margin3)
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

    times: deque = deque(maxlen=MAX_POINTS)
    prices: deque = deque(maxlen=MAX_POINTS)

    # ── Phase 1: read & plot every existing line ──────────────────────
    print(f"Reading existing data from {LOG_FILE} …")
    with open(LOG_FILE, "r") as f:
        existing = f.readlines()

    def process_and_plot(line: str):
        parsed = parse_line(line)
        if parsed is None:
            return
        dt, price = parsed
        times.append(dt)
        prices.append(price)
        if len(times) < 2:
            return
        t_list = list(times)
        p_list = list(prices)
        d1, d1_t, d2, d2_t = derivatives(t_list, p_list)
        update_plot(fig, ax1, ax2, ax3, l1, l2, l3,
                    t_list, p_list, d1, d1_t, d2, d2_t)
        plt.pause(0.001)

    for line in existing:
        process_and_plot(line)

    # ── Phase 2: tail for new lines ───────────────────────────────────
    print("Tailing for new ticks …  (Ctrl+C to stop)")
    try:
        for new_line in follow(LOG_FILE):
            process_and_plot(new_line)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        plt.ioff()
        plt.show(block=True)


if __name__ == "__main__":
    main()
