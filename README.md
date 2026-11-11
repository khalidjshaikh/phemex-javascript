# Phemex JavaScript Trading Toolkit

A personal research and automation toolkit for the [Phemex](https://phemex.com)
cryptocurrency exchange, written in TypeScript and run with Node.js + `tsx`.

It combines:

- **Reusable libraries** for signed REST calls, reconnecting WebSockets, order
  placement, position management, PnL analysis, and credential handling.
- **CLI tools** for inspecting accounts, markets, orders, fills, funding rates,
  and positions.
- **Automated trading bots** built around a live ticker feed
  (`ask` / `bid` / `index` / `mark` / `last`), especially the
  **index-vs-last ("I-L vector")** family of strategies.
- **Machine-learning experiments** — an online-learning neural network in pure
  JS, ONNX Runtime inference on the Apple Neural Engine (CoreML), and Python
  scikit-learn/XGBoost models for XRPUSDT.
- **Reference ticker implementations in 11 languages** under `ticker/`.

> **This is an experimentation repo, not a polished product.** Many ideas exist
> as numbered variants (`phemex-vector-strategy*.ts`,
> `phemex-ws-xbrusdt-monitor-ws*.ts`, `trader.ts` / `trader2.ts`, etc.). Treat
> the highest-numbered or most recently touched file as the current version,
> and read a script before running it.

---

## Repository layout

| Path | Purpose |
|------|---------|
| `src/` | Shared TypeScript libraries (API client, WebSocket, orders, positions, ML, utilities). |
| `scripts/` | 150+ CLI commands, monitors, and trading bots. Most are standalone `npx tsx` entry points. |
| `config/` | JSON5 strategy configs (`gm.json5`, `a02.json5`, `67b.json5`) mapping symbols to thresholds, size, leverage, hedge mode, etc. |
| `bin/` | Shell launchers for common bots, plus a DynamoDB flag helper. |
| `data/` | Runtime market-data snapshots written by ticker scripts (gitignored). |
| `models/` | Trained model artifacts: neural-net weights, ONNX graphs, Python `.pkl` models. |
| `logs/` | Bot logs, viewable through `scripts/log-viewer.ts` (gitignored). |
| `dev/` | Older order-query prototypes kept for reference. |
| `docs/` | Legacy script reference and design notes. |
| `ticker/` | The same BTCUSD WebSocket ticker implemented in C++, C#, Go, Java, Kotlin, PHP, Python, Ruby, Rust, Swift, and TypeScript. |
| `ticker-webgl.html` | Standalone WebGL browser ticker/chart. |

---

## How it works

### 1. Market data over WebSocket

`src/ws-client.ts` provides `ReconnectingWs`: a wrapper around Node's built-in
`WebSocket` that

- auto-reconnects with exponential backoff (1s → 30s),
- sends `server.ping` heartbeats every 20s,
- filters pongs and subscription acknowledgements,
- installs a clean `SIGINT` shutdown handler.

Bots subscribe to Phemex channels such as `perp_market24h_pack_p.subscribe`
(USDT-M) or `market24h.subscribe` (spot/Coin-M) and parse the
columnar payload into `ask`, `bid`, `index`, `mark`, and `last`.

### 2. Signed REST requests

`src/http-client.ts` implements the Phemex HMAC-SHA256 scheme:

```
signature = HMAC-SHA256(path + query + expiry + body, base64url-decoded secret)
```

It exposes `request`, `httpGet`, `httpDelete`, and `publicGet`, and sets the
`x-phemex-access-token`, `x-phemex-request-expiry`, and
`x-phemex-request-signature` headers.

### 3. Order placement

`src/place-limit-order.ts` is the central order API:

- `placeLimitOrder()` / `placeMarketOrder()` dispatch to the right endpoint for
  **Spot**, **USDT-M**, or **Coin-M** accounts.
- It handles Phemex's scaled integer fields (`priceEp`, `baseQtyEv`,
  `orderQtyRq`, `leverageEr`, …).
- Helpers `setLeverageUsdtM()` and `setLeverageCoinM()` configure cross-margin
  leverage.
- Remark: `placeLimitOrder()` schedules a background **auto-cancel after 60s**,
  which is convenient for probes but makes it unsuitable for resting ladders
  (those scripts call the lower-level `placeLinear` directly).

`src/positions.ts` wraps position reads, balance reads, PnL percentages, and
position closing.

### 4. The core strategy idea: the I-L vector

Most strategies in this repo revolve around the gap between the exchange's
**index price** and the **last traded price**:

```
vector = index − last
```

- `index > last` → the market is trading below its reference price → bullish bias.
- `index < last` → market above the reference → bearish bias.
- Entry when the vector crosses a threshold; exits use **delta bid / delta ask**
  (tick-to-tick quote changes), cumulative sums, hourly sums, slope, cooldowns,
  trailing take-profit, or PnL targets.

The bots track variants of these signals (`ΣΔbid−`, `ΣΔask+`, `Σ(I-L)`, hourly
sums, crossings, slope angle). `data/<SYMBOL>-{ask,bid,index,mark,last}.txt`
files are snapshots of the feed used by scripts that read from disk instead of
holding a WebSocket connection.

---

## `src/` library reference

| Module | What it provides |
|--------|------------------|
| `http-client.ts` | Base64url decoding, HMAC signing, signed/public HTTP requests. |
| `ws-client.ts` | `ReconnectingWs` — heartbeat + exponential-backoff WebSocket. |
| `credentials.ts` | Load `.phemex-credentials.json` or named profiles from `.credentials.json`. |
| `place-limit-order.ts` | Spot / USDT-M / Coin-M limit and market orders, leverage, cancellation. |
| `positions.ts` | Open positions, account balance, PnL %, close position. |
| `closed-positions.ts` | Reconstruct closed round-trips from fills using LIFO lot matching. |
| `untriggered-orders.ts` | List trigger orders that have not fired yet. |
| `spread-limit-order.ts` | Spread/dispersion limit-order ladders for `long-limit` / `short-limit`. |
| `pnl-calculator.ts` | Take-profit / stop-loss PnL for long and short trades. |
| `ema-calculator.ts` | Incremental EMA20 / EMA50 / EMA200 with restore support. |
| `mark-price.ts` | Stream mark/last price updates for a symbol over WebSocket. |
| `neural-net.ts` | Multi-task network: direction, magnitude, buy/sell/hold signal. |
| `neural-net-onnx.ts` | 1→8→8→8→1 network; trains in JS, infers via ONNX/CoreML. |
| `training.ts` | Tick collection, labeling, batch training, retraining pipeline. |
| `npu.ts` / `gpu.js` | Minimal "add two numbers" demos on Apple Neural Engine and WebGPU, used to validate acceleration paths. |
| `persistence.ts` | Safe JSON state save/load. |
| `notify.ts` / `mailer.ts` | SMTP email and email-to-SMS notifications (carrier gateways). |
| `dynamodb-flag.js` | Remote boolean flags in DynamoDB (`getFlag` / `setFlag`). |
| `cli-utils.ts` | `--flag` parsing, columnar ticker row lookup, API path selection. |
| `uuid.ts` | Client order IDs. |

---

## Trading scripts

### Config-driven multi-symbol trader

`scripts/trader2.ts` is the main config-driven bot. Each symbol gets its own
entry/exit parameters:

```json5
// config/gm.json5 (excerpt)
{
  XTIUSDT: { hedge: true, leverage: 100, profit: 0, size: 0.01,
             bias: -0.075, threshold: 0.45, errorBudget: 4 },
  XBRUSDT: { hedge: true, leverage: 100, profit: 0, size: 0.01,
             bias: -0.02, threshold: 1, errorBudget: 4 }
}
```

```bash
# Trade every symbol in the config using the "gmail" credential profile
npx tsx scripts/trader2.ts --configfile config/gm.json5 --credential gmail

# Restrict to a few symbols
npx tsx scripts/trader2.ts --configfile config/a02.json5 --credential A02 \
  --symbols XTIUSDT,XBRUSDT,XAUUSDT
```

| Config key | Meaning |
|-----------|---------|
| `threshold` | Index-vs-last trigger level. |
| `longThreshold` / `shortThreshold` | Optional asymmetric triggers. |
| `bias` | Constant offset added to the signal. |
| `size` | Order quantity. |
| `leverage` | Cross-margin leverage. |
| `hedge` | Allow Long and Short at the same time. |
| `profit` | Profit target used by some exit paths. |
| `realSymbol` | Trade a shared symbol but key the config separately (e.g. `XAUUSDT800`). |

### Index / vector strategy family

| Script | Description |
|--------|-------------|
| `phemex-index-trader.ts` | Loops on a symbol, reads `data/*` snapshots, tops each side up to a target size; supports `--hedge`, `--flip`, `--dry-run`. |
| `phemex-vector-strategy.ts` … `7.ts` | Iterations of the I-L entry + bid/ask-delta exit strategy; v7 adds slope mode, trailing take-profit, cumulative exits, and braille terminal charts. |
| `phemex-il-analyzer.ts` | Analyzes I-L sign, slope, duration, zero-crossings, and hourly summaries. |
| `xau-il-sigma.ts` | Tracks XAUUSDT I-L with per-minute Σ|I−L|. |
| `trader.ts` | Earlier config-driven trader (mostly superseded by `trader2.ts`). |

### Other bots and execution helpers

| Area | Scripts |
|------|---------|
| WebSocket auto-traders | `phemex-ws-auto-trader.ts`, `phemex-ws-auto-trader2.ts`, `phemex-ws-xtiusdt-trader.ts`, `phemex-ws-xrpusdt-ml-trader.ts` |
| EMA strategies | `phemex-ws-ema.ts`, `phemex-ws-ema-crossover.ts` |
| Ensemble / compound | `xtiusdt-compound-trader.ts` (EMA crossover, index divergence, Bollinger squeeze, RSI divergence, momentum, index gate) |
| Price rolling | `phemex-dime-roller.ts` (roll an XBRUSDT position every $0.10 move) |
| Order ladders | `phemex-limit-ladder.ts`, `phemex-limit-rungs.ts`, `phemex-create-tp-sl-ladder.ts`, `long-limit.ts`, `short-limit.ts` |
| Position protection | `phemex-ensure-stop-loss.ts`, `phemex-tp-to-index.ts`, `phemex-trim-position.ts`, `phemex-pnl-monitor.ts`, `phemex-watch-untriggered-orders.ts` |
| Bulk closing | `phemex-close-long.ts`, `phemex-close-short.ts`, `phemex-close-sweep.ts`, `phemex-close-limit-order.ts`, `phemex-usdt-positions.ts --close-all` |

---

## Inspection and account tools

```bash
# Public
npx tsx scripts/phemex-public-time.ts
npx tsx scripts/phemex-price.ts --symbol BTCUSDT
npx tsx scripts/phemex-perps.ts --symbol XTI
npx tsx scripts/phemex-funding-rates.ts --sort apr
npx tsx scripts/phemex-cli.ts list_symbols --perp

# Signed (credentials required)
npx tsx scripts/phemex-balances.ts
npx tsx scripts/phemex-usdt-positions.ts
npx tsx scripts/phemex-coinm-positions.ts
npx tsx scripts/phemex-list-open-positions.ts
npx tsx scripts/phemex-closed-positions.ts --symbol XBRUSDT --days 30
npx tsx scripts/phemex-list-fills.ts --symbol XBRUSDT
npx tsx scripts/phemex-order-history.ts --symbol XBRUSDT --days 7
npx tsx scripts/phemex-list-untriggered-orders.ts --symbol XBRUSDT
npx tsx scripts/phemex-cli.ts get_open_orders --symbol XBRUSDT
```

Also available: `phemex-cli.ts` (unified `list_symbols`, `get_open_orders`,
`cancel_order`, `cancel_all_orders`), `phemex-transfer.ts` (top up / drain
USDT between Spot and USDT-M), `phemex-auth.ts` (signature check), and
`scripts/select-credentials.ts` (switch the active account).

---

## Machine learning / AI experiments

Three separate stacks coexist:

1. **Pure-JS online learning** — `neural-net.ts` + `training.ts`
   Multi-task outputs: direction (binary), magnitude (regression), and signal
   (buy/hold/sell). Used by `phemex-npu-trader.ts`.

2. **ONNX Runtime + Apple CoreML** — `neural-net-onnx.ts` + `phemex-npu-trainer.ts`
   Backpropagation runs in JavaScript; inference is exported to ONNX and run
   with the `coreml` execution provider using `CPUAndNeuralEngine`, so the graph
   executes on the Apple Neural Engine rather than falling back to CPU.

3. **Python scikit-learn / XGBoost** — `scripts/xrpusdt_ml_model.py`
   Called as a subprocess by `phemex-ws-xrpusdt-ml-trader.ts`. It collects
   XRPUSDT ticks, trains Random Forest + XGBoost models, and trades when both
   agree and the predicted return clears a threshold. Models live in
   `models/xrpusdt/`.

```bash
npm run npu-trader -- --symbol PUMPUSDT --dry-run
npm run npu-trainer -- --symbol PUMPUSDT --train-only
npm run npu-trainer -- --symbol PUMPUSDT --export-onnx
npx tsx scripts/phemex-ws-xrpusdt-ml-trader.ts --dry-run
```

`src/npu.ts` (CoreML/ANE) and `src/gpu.js` (WebGPU/WGSL) intentionally do
nothing trading-related — they are minimal `C = A + B` programs used to verify
that each acceleration path works on the host machine.

---

## Multi-language ticker implementations

`ticker/` contains the same BTCUSD 24h-ticker client implemented in:

`cpp-ticker/`, `csharp-ticker/`, `go-ticker/`, `java-ticker/`, `kt-ticker/`,
`php-ticker/`, `py-ticker/`, `rb-ticker/`, `rust-ticker/`, `swift-ticker/`,
`ts-ticker/`.

Each one subscribes to `market24h.subscribe`, prints the last price on change,
prints `♥` on heartbeat pongs, reconnects with exponential backoff, and exits
cleanly on `Ctrl+C`. They are useful for comparing WebSocket/TLS ergonomics
across languages. The TypeScript version reuses the root `src/ws-client.ts`;
see `ticker/cpp-ticker/README.md` for a representative build guide.

---

## Getting started

### Requirements

- Node.js ≥ 18 (native `fetch` / `WebSocket`)
- `npm install` for TypeScript execution, ONNX Runtime, WebGPU, AWS SDK,
  nodemailer, and `termdot`
- Optional: Python 3 with `scikit-learn`, `xgboost`, `pandas` for the XRPUSDT
  ML bot
- Apple Silicon only for the CoreML/ANE path

### Install

```bash
npm install
```

### Configure credentials

Two patterns are supported:

**Single active account** — `.phemex-credentials.json` in the repo root:

```json
{
  "PHEMEX_API_KEY": "00000000-0000-0000-0000-000000000000",
  "PHEMEX_API_SECRET": "base64url-encoded-secret"
}
```

**Named profiles** — `.credentials.json`, based on
`.credentials-sample.json`:

```json
{
  "gmail": { "PHEMEX_API_KEY": "...", "PHEMEX_API_SECRET": "..." },
  "meta":  { "PHEMEX_API_KEY": "...", "PHEMEX_API_SECRET": "..." }
}
```

Select the active profile with:

```bash
npm run creds -- --list
npm run creds -- --name meta
```

Bots that accept `--credential <name>` read the named file directly and do not
need the active-profile copy.

> **Security:** the secret is Base64url-encoded (as issued by Phemex).
> `.phemex-credentials.json`, `.credentials.json`, and `.env` are gitignored.
> Never commit real keys. Use API keys with only the permissions the strategy
> needs, and prefer disabling withdrawals.

### First commands

```bash
# No credentials needed
npx tsx scripts/phemex-public-time.ts
npx tsx scripts/phemex-price.ts --symbol BTCUSDT

# Read-only account checks
npx tsx scripts/phemex-balances.ts
npx tsx scripts/phemex-usdt-positions.ts

# Signal-only run of a strategy
npx tsx scripts/phemex-index-trader.ts --dry-run
npx tsx scripts/trader2.ts --configfile config/gm.json5 --credential gmail
```

---

## npm scripts

| Command | Runs |
|---------|------|
| `npm run gpu` | WebGPU add demo |
| `npm run npu` | CoreML/ANE add demo |
| `npm run npu-trader` | Neural-net trader |
| `npm run npu-trainer` | Neural-net trainer / ONNX exporter |
| `npm run creds` | Credential profile selector |
| `npm run index-trader` | Index-signal trader |
| `npm run xti-trader` | XTIUSDT WebSocket trader |
| `npm run xrp-trader` | XRPUSDT ML trader |
| `npm run closed-positions` | Closed-position report |
| `npm run graph` | Render `ticker.csv` to Plotly HTML |
| `npm run number-line` | Number-line price plot |
| `npm run price` | Current price lookup |
| `npm run min-fee` | Minimum-quantity fee estimate |
| `npm run perps` | USDT-M perpetual listing |
| `npm run transfer` | Spot ↔ USDT-M transfer |
| `npm run symbols` | Symbol listing |
| `npm run log-viewer` | Local log dashboard (port 3456) |

Any other script runs directly: `npx tsx scripts/<name>.ts --help`.

---

## Runtime data and state

| File / folder | Written by | Contains |
|---------------|-----------|----------|
| `data/<SYMBOL>-{ask,bid,index,mark,last}.txt` | `phemex-ws-ticker-data3.ts --store`, `phemex-mark-price2.ts` | Latest market snapshot. |
| `data/<SYMBOL>-deltaLSamples.json`, `-histogram.json` | Signal analyzers | Tick history for analysis. |
| `logs/*.log` | Bots | Timestamped run logs. |
| `models/<symbol>/` | Trainers | Weights, normalization stats, ONNX graphs. |
| `.phemex-il-state.json` | I-L strategies | Restart state. |
| `.phemex-ws-ema-*.json` | EMA bots | Price history and position state. |

These files make bots resumable and give offline scripts (like
`phemex-index-trader.ts`) something to read.

---

## Conventions and notes

- Every source file carries `SPDX-License-Identifier: MIT`.
- Scripts are designed to be run with `tsx`; shebangs use
  `#!/usr/bin/env -S npx tsx`.
- Numbered filenames are snapshots of an evolving idea, not stable releases.
  Examples: `phemex-vector-strategy.ts` → `…7.ts`,
  `phemex-ws-xbrusdt-monitor-ws.ts` → `…6.ts`, `trader.ts` → `trader2.ts`.
- Several bots default to **dry-run**, but not all. Check the usage banner:
  `phemex-ws-xtiusdt-trader.ts` is dry-run unless `--live`;
  `trader2.ts`, `phemex-index-trader.ts` (without `--dry-run`), and
  `phemex-ws-xrpusdt-ml-trader.ts` place real orders.

---

## Documentation

- `docs/README.md` — older, detailed walkthrough of the original CLI scripts.
- `docs/PLAN-ema-crossover.md` — design notes for the EMA20/50 + EMA200 filter bot.
- `ticker/cpp-ticker/README.md` — build instructions for the C++ ticker.
- Each script prints its own usage with `--help`; that is the most reliable
  reference for flags and defaults.

---

## Disclaimer

This code is for research and personal automation. It can place real orders and
lose real money. Cryptocurrency derivatives with leverage are extremely risky.
Review every strategy, start with dry-run or `--size` at the exchange minimum,
and use API keys restricted to trading only. The authors accept no liability
for financial losses.

## License

MIT (see the `SPDX-License-Identifier` headers in each source file).
