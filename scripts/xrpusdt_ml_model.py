#!/usr/bin/env python3
"""
XRPUSDT ML Model — Train RF + XGBoost, predict on live features.

Communicates with the TypeScript trader via stdin/stdout JSON protocol.

Protocol:
  TS → Python:  {"action": "train", "prices": [...], "volumes": [...]}
  TS → Python:  {"action": "predict", "features": {...}}
  TS → Python:  {"action": "save", "path": "model_dir"}
  TS → Python:  {"action": "load", "path": "model_dir"}
  Python → TS:  {"status": "trained", "features": [...], "train_samples": N}
  Python → TS:  {"status": "predicted", "rf": float, "xgb": float, "ensemble": float}
  Python → TS:  {"status": "saved"}
  Python → TS:  {"status": "loaded"}
  Python → TS:  {"status": "error", "message": "..."}
"""

import sys
import json
import os
import warnings
import numpy as np

warnings.filterwarnings("ignore")

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "xrpusdt")


def ema(arr, period):
    n = len(arr)
    out = np.full(n, np.nan)
    a = 2 / (period + 1)
    out[0] = arr[0]
    for i in range(1, n):
        out[i] = a * arr[i] + (1 - a) * (out[i - 1] if not np.isnan(out[i - 1]) else arr[i])
    return out


def compute_features(p, v):
    """Compute feature vector from price and volume arrays."""
    n = len(p)
    d = {}

    for lag in [1, 2, 3, 5, 10, 20]:
        if lag < n:
            d[f"ret_{lag}d"] = p[-1] / p[-1 - lag] - 1.0
        else:
            d[f"ret_{lag}d"] = 0.0

    for w in [5, 10, 20, 50, 200]:
        if w <= n:
            ma = np.mean(p[-w:])
            d[f"ratio_ma_{w}"] = p[-1] / ma if ma != 0 else 1.0
        else:
            d[f"ratio_ma_{w}"] = 1.0

    for fast, slow in [(5, 20), (10, 50), (20, 200)]:
        if slow <= n:
            ma_f = np.mean(p[-fast:])
            ma_s = np.mean(p[-slow:])
            d[f"ma_cross_{fast}_{slow}"] = ma_f / ma_s if ma_s != 0 else 1.0
        else:
            d[f"ma_cross_{fast}_{slow}"] = 1.0

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

    if n >= 20:
        bb_ma = np.mean(p[-20:])
        bb_std = np.std(p[-20:])
        upper = bb_ma + 2 * bb_std
        lower = bb_ma - 2 * bb_std
        d["bb_pos"] = (p[-1] - lower) / max(upper - lower, 1e-12)
    else:
        d["bb_pos"] = 0.5

    for w in [5, 10, 20]:
        if w <= n:
            d[f"vol_{w}d"] = np.std(p[-w:]) / (np.mean(p[-w:]) + 1e-12)
        else:
            d[f"vol_{w}d"] = 0.0

    if np.any(v > 0):
        vr = v[-1] / max(v[-2], 1) - 1.0 if len(v) >= 2 else 0.0
        d["vol_ret"] = vr
        for w in [5, 20]:
            if w <= len(v):
                vma = np.mean(v[-w:])
                d[f"vol_ratio_{w}"] = v[-1] / max(vma, 1)
            else:
                d[f"vol_ratio_{w}"] = 1.0
    else:
        d["vol_ret"] = 0.0
        d["vol_ratio_5"] = 1.0
        d["vol_ratio_20"] = 1.0

    return d


def build_training_matrix(prices, volumes, forward=10):
    """Build feature matrix and targets from price/volume arrays."""
    n = len(prices)
    min_lookback = 200

    if n < min_lookback + forward + 10:
        return None, None, None

    rows = []
    targets = []

    for i in range(min_lookback, n - forward):
        p_hist = prices[:i + 1]
        v_hist = volumes[:i + 1]
        feat = compute_features(p_hist, v_hist)
        fwd_ret = prices[i + forward] / prices[i] - 1.0
        rows.append(feat)
        targets.append(fwd_ret)

    import pandas as pd
    df_feats = pd.DataFrame(rows)
    return df_feats, np.array(targets), df_feats.columns.tolist()


def train(prices, volumes):
    """Train RF + XGBoost on collected data."""
    from sklearn.preprocessing import StandardScaler
    from sklearn.ensemble import RandomForestRegressor
    import xgboost as xgb
    import pandas as pd

    X_all, y_all, feat_cols = build_training_matrix(prices, volumes)
    if X_all is None or len(X_all) < 500:
        return None, "Not enough data for training (need 500+ samples)"

    split = int(len(X_all) * 0.80)
    X_tr, X_te = X_all.iloc[:split].values, X_all.iloc[split:].values
    y_tr, y_te = y_all[:split], y_all[split:]

    recent_n = int(len(X_tr) * 0.50)
    X_tr = X_tr[recent_n:]
    y_tr = y_tr[recent_n:]

    scaler = StandardScaler()
    Xtr = scaler.fit_transform(X_tr)
    Xte = scaler.transform(X_te)

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

    models = {
        "rf": rf,
        "xgb": xgb_r,
        "scaler": scaler,
        "feat_cols": feat_cols,
    }

    return models, None


def predict(models, features_dict):
    """Predict using trained models."""
    import pandas as pd

    feat_cols = models["feat_cols"]
    X = pd.DataFrame([features_dict])[feat_cols].values
    Xs = models["scaler"].transform(X)

    rf_out = float(models["rf"].predict(Xs)[0])
    xgb_out = float(models["xgb"].predict(Xs)[0])
    ens_out = 0.50 * rf_out + 0.50 * xgb_out

    return rf_out, xgb_out, ens_out


def save_models(models, path):
    """Save trained models to disk."""
    import joblib
    os.makedirs(path, exist_ok=True)
    joblib.dump(models["rf"], os.path.join(path, "rf_model.pkl"))
    joblib.dump(models["xgb"], os.path.join(path, "xgb_model.pkl"))
    joblib.dump(models["scaler"], os.path.join(path, "scaler.pkl"))
    joblib.dump(models["feat_cols"], os.path.join(path, "feat_cols.pkl"))


def load_models(path):
    """Load trained models from disk."""
    import joblib
    rf = joblib.load(os.path.join(path, "rf_model.pkl"))
    xgb_r = joblib.load(os.path.join(path, "xgb_model.pkl"))
    scaler = joblib.load(os.path.join(path, "scaler.pkl"))
    feat_cols = joblib.load(os.path.join(path, "feat_cols.pkl"))
    return {"rf": rf, "xgb": xgb_r, "scaler": scaler, "feat_cols": feat_cols}


def main():
    models = None
    model_dir = MODEL_DIR

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            _respond({"status": "error", "message": "Invalid JSON"})
            continue

        action = msg.get("action")

        if action == "load":
            path = msg.get("path", model_dir)
            try:
                models = load_models(path)
                _respond({"status": "loaded", "features": models["feat_cols"]})
            except Exception as e:
                _respond({"status": "error", "message": str(e)})

        elif action == "save":
            path = msg.get("path", model_dir)
            if models is None:
                _respond({"status": "error", "message": "No models to save"})
            else:
                try:
                    save_models(models, path)
                    _respond({"status": "saved"})
                except Exception as e:
                    _respond({"status": "error", "message": str(e)})

        elif action == "train":
            prices = msg.get("prices", [])
            volumes = msg.get("volumes", [])
            if len(prices) < 10:
                _respond({"status": "error", "message": "Need at least 10 prices"})
                continue
            models, err = train(prices, volumes)
            if err:
                _respond({"status": "error", "message": err})
            else:
                _respond({
                    "status": "trained",
                    "features": models["feat_cols"],
                    "train_samples": len(models["feat_cols"]),
                })

        elif action == "predict":
            if models is None:
                _respond({"status": "error", "message": "Models not trained or loaded"})
                continue
            features = msg.get("features", {})
            try:
                rf_out, xgb_out, ens_out = predict(models, features)
                _respond({
                    "status": "predicted",
                    "rf": rf_out,
                    "xgb": xgb_out,
                    "ensemble": ens_out,
                })
            except Exception as e:
                _respond({"status": "error", "message": str(e)})

        else:
            _respond({"status": "error", "message": f"Unknown action: {action}"})


def _respond(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
