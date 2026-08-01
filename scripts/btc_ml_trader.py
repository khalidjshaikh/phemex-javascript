#!/usr/bin/env python3
"""
BTC/USD ML Trading Classifier  v5

Strategy:
  - Train Random Forest + XGBoost regressors on features → 10d forward return.
  - Use the LATEST price point's features (2026-07-04) for live prediction.
  - Market-regime filter: up-trend / down-trend based on MA200.
  - Trade only when BOTH models agree and predicted |return| > threshold.

For the recommendation, we compute features for the latest date separately
from the training labels (no NaN target needed for inference).
"""

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.ensemble import RandomForestRegressor
import xgboost as xgb
import argparse, json, asyncio
import warnings, sys
from datetime import datetime

import websockets

warnings.filterwarnings("ignore")

DATA_PATH = "/Users/khalid/git/phemex-javascript/btc-usd-max-trimmed.csv"
LABEL_MAP = {0: "NO_TRADE 🔹", 1: "LONG 📈", 2: "SHORT 📉"}


def load_data(path):
    df = pd.read_csv(path, parse_dates=["event_date"])
    df.rename(columns={"event_date": "date", "close_price_usd": "close"}, inplace=True)
    if "volume_usd" in df.columns:
        df.rename(columns={"volume_usd": "volume"}, inplace=True)
        df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0)
    else:
        df["volume"] = 0.0
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    df.dropna(subset=["close"], inplace=True)
    df.sort_values("date", inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df


def ema(arr, period):
    n = len(arr)
    out = np.full(n, np.nan)
    a = 2 / (period + 1)
    out[0] = arr[0]
    for i in range(1, n):
        out[i] = a * arr[i] + (1 - a) * (out[i - 1] if not np.isnan(out[i - 1]) else arr[i])
    return out


def compute_features(p, v, n):
    """Compute feature vector for a single point given its price history."""
    d = {}

    # Returns
    for lag in [1, 2, 3, 5, 10, 20]:
        if lag < n:
            d[f"ret_{lag}d"] = p[-1] / p[-1 - lag] - 1.0
        else:
            d[f"ret_{lag}d"] = 0.0

    # MA ratios
    for w in [5, 10, 20, 50, 200]:
        if w <= n:
            ma = np.mean(p[-w:])
            d[f"ratio_ma_{w}"] = p[-1] / ma
            d[f"ma_{w}"] = ma
        else:
            d[f"ratio_ma_{w}"] = 1.0
            d[f"ma_{w}"] = p[-1]

    # MA crossovers
    for fast, slow in [(5, 20), (10, 50), (20, 200)]:
        if slow <= n:
            ma_f = np.mean(p[-fast:])
            ma_s = np.mean(p[-slow:])
            d[f"ma_cross_{fast}_{slow}"] = ma_f / ma_s
        else:
            d[f"ma_cross_{fast}_{slow}"] = 1.0

    # RSI
    if n >= 15:
        diffs = np.diff(p[-(15):])
        g = np.where(diffs > 0, diffs, 0.0)
        l = np.where(diffs < 0, -diffs, 0.0)
        ag = np.mean(g)
        al = np.mean(l)
        rsi = 100 - 100 / (1 + ag / max(al, 1e-12))
    else:
        rsi = 50.0
    d["rsi_14"] = rsi
    d["rsi_zone"] = 1 if rsi > 70 else (-1 if rsi < 30 else 0)

    # MACD
    if n >= 27:
        e12 = ema(p, 12)[-1]
        e26 = ema(p, 26)[-1]
        macd_v = e12 - e26
        sig = ema(np.full(n, macd_v), 9)[-1]
    else:
        macd_v = 0.0
        sig = 0.0
    d["macd"] = macd_v
    d["macd_sig"] = sig
    d["macd_hist"] = macd_v - sig
    d["macd_cross"] = 1 if macd_v > sig else (-1 if macd_v < sig else 0)

    # Bollinger
    if n >= 20:
        bb_ma = np.mean(p[-20:])
        bb_std = np.std(p[-20:])
        upper = bb_ma + 2 * bb_std
        lower = bb_ma - 2 * bb_std
        d["bb_pos"] = (p[-1] - lower) / max(upper - lower, 1e-12)
    else:
        d["bb_pos"] = 0.5

    # Volatility
    for w in [5, 10, 20]:
        if w <= n:
            d[f"vol_{w}d"] = np.std(p[-w:]) / (np.mean(p[-w:]) + 1e-12)
        else:
            d[f"vol_{w}d"] = 0.0

    # Volume
    vol_hist = v
    if np.any(v > 0):
        vr = vol_hist[-1] / max(vol_hist[-2], 1) - 1.0 if len(vol_hist) >= 2 else 0.0
        d["vol_ret"] = vr
        for w in [5, 20]:
            if w <= len(vol_hist):
                vma = np.mean(vol_hist[-w:])
                d[f"vol_ratio_{w}"] = vol_hist[-1] / max(vma, 1)
            else:
                d[f"vol_ratio_{w}"] = 1.0
    else:
        d["vol_ret"] = 0.0
        d["vol_ratio_5"] = 1.0
        d["vol_ratio_20"] = 1.0

    return d


def build_training_matrix(df):
    """Build (X, y) matrix for all rows where target (10d fwd return) exists."""
    p_all = df["close"].values
    v_all = df["volume"].values
    n_all = len(p_all)

    rows = []
    targets = []

    for i in range(200, n_all - 10):  # need 200 lookback, 10 forward
        p_hist = p_all[: i + 1]  # includes current
        v_hist = v_all[: i + 1]
        feat = compute_features(p_hist, v_hist, len(p_hist))
        fwd_ret = p_all[i + 10] / p_all[i] - 1.0
        rows.append(feat)
        targets.append(fwd_ret)

    df_feats = pd.DataFrame(rows)
    return df_feats, np.array(targets)


def build_latest_features(df):
    """Build feature vector for the absolute latest date."""
    p_all = df["close"].values
    v_all = df["volume"].values
    n = len(p_all)
    feat = compute_features(p_all, v_all, n)
    return pd.DataFrame([feat])


# ---------------------------------------------------------------------------
#  Live integration — Phemex WebSocket price feed
# ---------------------------------------------------------------------------

WS_URL = "wss://ws.phemex.com"
WS_SYMBOL = "BTCUSD"
WS_PRICE_SCALE = 10_000
WS_HEARTBEAT_INTERVAL = 20  # seconds


def _price_from_msg(msg: dict) -> float | None:
    """Extract the BTCUSD close price from a market24h ticker message."""
    market24h = msg.get("market24h")
    if isinstance(market24h, dict) and market24h.get("symbol") == WS_SYMBOL:
        close_ep = market24h.get("close")
        if close_ep is not None:
            return close_ep / WS_PRICE_SCALE
    return None


async def _live_heartbeat(ws):
    """Send server.ping every WS_HEARTBEAT_INTERVAL seconds."""
    while True:
        await asyncio.sleep(WS_HEARTBEAT_INTERVAL)
        try:
            await ws.send(
                json.dumps({"method": "server.ping", "params": [], "id": int(asyncio.get_event_loop().time() * 1000)})
            )
        except websockets.ConnectionClosed:
            break


def _print_recommendation(price: float, p_hist, rf, xgb_r, scaler, feat_cols, vol_hist):
    """Run ML inference on a live price and print the recommendation block."""
    # Build feature vector: append live price to historical prices
    p_ext = np.append(p_hist, price)
    v_ext = np.append(vol_hist, 0.0)  # no live volume; use 0
    feat = compute_features(p_ext, v_ext, len(p_ext))
    X = pd.DataFrame([feat])[feat_cols].values
    Xs = scaler.transform(X)

    rf_out = float(rf.predict(Xs)[0])
    xgb_out = float(xgb_r.predict(Xs)[0])
    ens_out = 0.50 * rf_out + 0.50 * xgb_out

    n = len(p_hist)
    ma200 = np.mean(p_hist[-200:]) if n >= 200 else np.mean(p_hist)
    ma50 = np.mean(p_hist[-50:]) if n >= 50 else np.mean(p_hist)
    above_ma200 = "above" if price > ma200 else "below"
    above_ma50 = "above" if price > ma50 else "below"
    ret_5d = price / p_hist[-6] - 1.0 if n >= 6 else 0.0
    ret_10d = price / p_hist[-11] - 1.0 if n >= 11 else 0.0

    print(f"\n{'=' * 60}")
    print(f"  📌 LIVE RECOMMENDATION — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'=' * 60}")
    print(f"     BTC Price:            ${price:>10,.2f}")
    print(f"     Market regime:")
    print(f"       Price vs MA200:     {above_ma200} (${ma200:>8,.2f})")
    print(f"       Price vs MA50:      {above_ma50} (${ma50:>8,.2f})")
    print(f"       5d return:          {ret_5d*100:+.2f}%")
    print(f"       10d return:         {ret_10d*100:+.2f}%")
    print(f"{'─' * 60}")
    print(f"     Predicted 10d return:")
    print(f"       RF:      {rf_out*100:+.2f}%")
    print(f"       XGBoost: {xgb_out*100:+.2f}%")
    print(f"       Ens:     {ens_out*100:+.2f}%")

    both_bullish = rf_out > 0.025 and xgb_out > 0.025
    both_bearish = rf_out < -0.025 and xgb_out < -0.025
    strong_bullish = rf_out > 0.04 and xgb_out > 0.02
    strong_bearish = rf_out < -0.04 and xgb_out < -0.02

    momentum_up = ret_5d > 0.02 and ret_10d > 0.01
    trend_down = price < ma50 and price < ma200
    conflict = momentum_up and trend_down

    if both_bullish or strong_bullish:
        conf = "HIGH" if both_bullish else "MODERATE"
        print(f"\n     📍 RECOMMENDATION: LONG 📈  (Confidence: {conf})")
        print(f"     📈 ML models predict positive 10-day return. Bullish bias.")
        if momentum_up:
            print(f"     📈 Short-term momentum positive.")
    elif both_bearish or strong_bearish:
        conf = "HIGH" if both_bearish else "MODERATE"
        print(f"\n     📍 RECOMMENDATION: SHORT 📉  (Confidence: {conf})")
        if conflict:
            print(f"     ⚠️  CONFLICT: Price below MAs (bearish) but short-term")
            print(f"     ⚠️  momentum is positive (+{ret_5d*100:.1f}% 5d). Higher risk.")
        print(f"     📉 ML models predict negative 10-day return. Bearish setup.")
    else:
        print(f"\n     📍 RECOMMENDATION: NO TRADE 🔹")
        print(f"     🔹 ML models lack consensus or weak signal magnitude.")

    print(f"{'=' * 60}\n")


async def live_predict_loop(models, df):
    """
    Connect to Phemex WebSocket and run ML inference on every price tick.
    Prints a compact price stream (like phemex-ws-price.py) plus a full
    recommendation block whenever the price has changed.
    """
    rf, xgb_r, scaler, feat_cols = models
    p_hist = df["close"].values
    v_hist = df["volume"].values
    last_price: float | None = None
    last_print: float | None = None

    # Exponential backoff reconnect
    delay = 1.0
    max_delay = 30.0

    while True:
        try:
            async with websockets.connect(WS_URL, ping_interval=None) as ws:
                delay = 1.0  # reset on connect
                await ws.send(
                    json.dumps({"method": "market24h.subscribe", "params": [], "id": 2})
                )
                hb_task = asyncio.create_task(_live_heartbeat(ws))

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    # Pong
                    if msg.get("result") == "pong":
                        print("♥", end="", flush=True)
                        continue

                    if msg.get("error") is not None:
                        print(f"\n[WS error: {msg['error']}]", file=sys.stderr)
                        continue

                    if isinstance(msg.get("result"), dict) and msg["result"].get("status") == "success":
                        continue

                    price = _price_from_msg(msg)
                    if price is None:
                        continue

                    # Compact price line (only on change, like phemex-ws-price.py)
                    if last_price is None or price != last_price:
                        now = datetime.now().strftime("%m/%d/%Y, %H:%M:%S")
                        print(f"\n{now}  {price:.2f} ", end="", flush=True)
                        last_price = price

                    # Full recommendation block (only when price differs from last printed rec)
                    if last_print is None or price != last_print:
                        _print_recommendation(price, p_hist, rf, xgb_r, scaler, feat_cols, v_hist)
                        last_print = price

                hb_task.cancel()
                try:
                    await hb_task
                except asyncio.CancelledError:
                    pass

        except (websockets.ConnectionClosed, OSError):
            pass

        if not asyncio.get_event_loop().is_running():
            break

        print(f"\n[reconnecting in {delay:.0f}s...]", flush=True)
        await asyncio.sleep(delay)
        delay = min(delay * 2, max_delay)


def _train_and_report(df):
    """
    Train RF + XGBoost on df, print evaluation, return (rf, xgb_r, scaler, feat_cols, p_hist, v_hist).
    """
    X_all, y_all = build_training_matrix(df)
    feat_cols = X_all.columns.tolist()
    print(f"🔧 Features: {len(feat_cols)}")
    print(f"🧹 Training samples: {len(X_all)}")

    if len(X_all) < 500:
        print("❌ Not enough data")
        sys.exit(1)

    # Train/test split (time series)
    split = int(len(X_all) * 0.80)
    X_tr, X_te = X_all.iloc[:split].values, X_all.iloc[split:].values
    y_tr, y_te = y_all[:split], y_all[split:]

    # Only use recent 50% of training (ignore ancient 2013-2016 data)
    recent_n = int(len(X_tr) * 0.50)
    X_tr = X_tr[recent_n:]
    y_tr = y_tr[recent_n:]

    print(f"📚 Train: {len(X_tr)} (recent 50%), Test: {len(X_te)}")
    print(f"   Target mean: {y_all.mean()*100:+.2f}%")

    scaler = StandardScaler()
    Xtr = scaler.fit_transform(X_tr)
    Xte = scaler.transform(X_te)

    # ── Train ──
    print("\n🚀 Training RF + XGBoost regressors ...")

    rf = RandomForestRegressor(
        n_estimators=150, max_depth=4, min_samples_leaf=30,
        random_state=42, n_jobs=-1,
    )
    rf.fit(Xtr, y_tr)

    xgb_r = xgb.XGBRegressor(
        n_estimators=150, max_depth=3, learning_rate=0.03,
        subsample=0.7, colsample_bytree=0.7,
        reg_lambda=5, reg_alpha=2,
        verbosity=0, random_state=42,
    )
    xgb_r.fit(Xtr, y_tr)

    # ── Evaluate on test set ──
    from sklearn.metrics import r2_score, mean_squared_error
    rf_pred = rf.predict(Xte)
    xgb_pred = xgb_r.predict(Xte)
    ens_pred = 0.50 * rf_pred + 0.50 * xgb_pred

    print(f"\n📈 Test R²:")
    print(f"   RF:     {r2_score(y_te, rf_pred):+.4f}")
    print(f"   XGBoost: {r2_score(y_te, xgb_pred):+.4f}")
    print(f"   Ensemble: {r2_score(y_te, ens_pred):+.4f}")
    print(f"   RMSE:    {np.sqrt(mean_squared_error(y_te, ens_pred))*100:.2f}%")

    # Signal backtest
    long_sig = (rf_pred > 0.025) & (xgb_pred > 0.025)
    short_sig = (rf_pred < -0.025) & (xgb_pred < -0.025)
    trade_sig = np.zeros(len(ens_pred))
    trade_sig[long_sig] = 1
    trade_sig[short_sig] = 2

    long_c = int((trade_sig == 1).sum())
    short_c = int((trade_sig == 2).sum())
    long_w = int(((trade_sig == 1) & (y_te > 0)).sum())
    short_w = int(((trade_sig == 2) & (y_te < 0)).sum())
    total = long_c + short_c
    total_w = long_w + short_w

    print(f"\n📊 Test signals (both models agree ±2.5%):")
    print(f"   LONG:  {long_c} trades (win {long_w/max(long_c,1)*100:.0f}%)")
    print(f"   SHORT: {short_c} trades (win {short_w/max(short_c,1)*100:.0f}%)")
    print(f"   Total: {total} trades (win {total_w/max(total,1)*100:.1f}%)")

    # Feature importance
    imp = (rf.feature_importances_ + xgb_r.feature_importances_) / 2
    top = np.argsort(imp)[::-1][:8]
    print(f"\n🔝 Top 8 Features:")
    for r, i in enumerate(top, 1):
        bar = "▓" * int(imp[i] * 100)
        print(f"     {r:2d}. {feat_cols[i]:22s}  {imp[i]:.4f}  {bar}")

    return rf, xgb_r, scaler, feat_cols


def main():
    parser = argparse.ArgumentParser(
        description="BTC/USD ML Trading Classifier — train on CSV, then predict (static or live)."
    )
    parser.add_argument(
        "--live", "-l",
        action="store_true",
        help="After training, connect to Phemex WebSocket for live price predictions."
    )
    args = parser.parse_args()

    print("=" * 60)
    print("  BTC/USD ML Trading Classifier  v5")
    if args.live:
        print("  Mode: TRAIN + LIVE WEBSOCKET")
    else:
        print("  Mode: TRAIN + STATIC PREDICTION")
    print("=" * 60)

    df = load_data(DATA_PATH)
    print(f"\n📊 Data: {len(df)} rows, {df['date'].min().date()} → {df['date'].max().date()}")
    print(f"   Price: ${df['close'].min():>8,.2f} → ${df['close'].max():>8,.2f}")

    # Train
    rf, xgb_r, scaler, feat_cols = _train_and_report(df)

    if args.live:
        # ── Live WebSocket mode ──
        print(f"\n{'=' * 60}")
        print(f"  🌐 Connecting to Phemex WebSocket for live prices...")
        print(f"{'=' * 60}")
        try:
            asyncio.run(live_predict_loop((rf, xgb_r, scaler, feat_cols), df))
        except KeyboardInterrupt:
            print("\n\n👋 Shutting down live trader.")
    else:
        # ── Static prediction from latest CSV row ──
        latest_feat = build_latest_features(df)
        latest_X = latest_feat[feat_cols].values
        latest_scaled = scaler.transform(latest_X)

        rf_out = float(rf.predict(latest_scaled)[0])
        xgb_out = float(xgb_r.predict(latest_scaled)[0])
        ens_out = 0.50 * rf_out + 0.50 * xgb_out

        latest_price = df["close"].iloc[-1]
        latest_date = df["date"].iloc[-1]

        p_all = df["close"].values
        n = len(p_all)
        ma200 = np.mean(p_all[-200:]) if n >= 200 else np.mean(p_all)
        ma50 = np.mean(p_all[-50:]) if n >= 50 else np.mean(p_all)
        above_ma200 = "above" if latest_price > ma200 else "below"
        above_ma50 = "above" if latest_price > ma50 else "below"
        ret_5d = p_all[-1] / p_all[-6] - 1.0 if n >= 6 else 0.0
        ret_10d = p_all[-1] / p_all[-11] - 1.0 if n >= 11 else 0.0

        print(f"\n{'=' * 60}")
        print(f"  📌 TRADE RECOMMENDATION — {latest_date.date()}")
        print(f"{'=' * 60}")
        print(f"     BTC Price:            ${latest_price:>10,.2f}")
        print(f"     Market regime:")
        print(f"       Price vs MA200:     {above_ma200} (${ma200:>8,.2f})")
        print(f"       Price vs MA50:      {above_ma50} (${ma50:>8,.2f})")
        print(f"       5d return:          {ret_5d*100:+.2f}%")
        print(f"       10d return:         {ret_10d*100:+.2f}%")
        print(f"{'─' * 60}")
        print(f"     Predicted 10d return:")
        print(f"       RF:      {rf_out*100:+.2f}%")
        print(f"       XGBoost: {xgb_out*100:+.2f}%")
        print(f"       Ens:     {ens_out*100:+.2f}%")

        both_bullish = rf_out > 0.025 and xgb_out > 0.025
        both_bearish = rf_out < -0.025 and xgb_out < -0.025
        strong_bullish = rf_out > 0.04 and xgb_out > 0.02
        strong_bearish = rf_out < -0.04 and xgb_out < -0.02

        momentum_up = ret_5d > 0.02 and ret_10d > 0.01
        trend_down = latest_price < ma50 and latest_price < ma200
        conflict = momentum_up and trend_down

        if both_bullish or strong_bullish:
            conf = "HIGH" if both_bullish else "MODERATE"
            print(f"\n     📍 RECOMMENDATION: LONG 📈  (Confidence: {conf})")
            print(f"     📈 ML models predict positive 10-day return. Bullish bias.")
            if momentum_up:
                print(f"     📈 Short-term momentum positive.")
        elif both_bearish or strong_bearish:
            conf = "HIGH" if both_bearish else "MODERATE"
            print(f"\n     📍 RECOMMENDATION: SHORT 📉  (Confidence: {conf})")
            if conflict:
                print(f"     ⚠️  CONFLICT: Price below MAs (bearish) but short-term")
                print(f"     ⚠️  momentum is positive (+{ret_5d*100:.1f}% 5d). Higher risk.")
            print(f"     📉 ML models predict negative 10-day return. Bearish setup.")
        else:
            print(f"\n     📍 RECOMMENDATION: NO TRADE 🔹")
            print(f"     🔹 ML models lack consensus or weak signal magnitude.")

        print(f"{'=' * 60}")
        print(f"\n   ⚠️  Not financial advice. Trading carries significant risk.\n")


if __name__ == "__main__":
    main()
