# Phemex JavaScript CLI Tools

A collection of command-line utilities for interacting with the [Phemex](https://phemex.com) cryptocurrency exchange API. Supports **Spot**, **USDT-M Perpetual**, and **Coin-M Inverse Perpetual** accounts.

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18 (for native `fetch` / `WebSocket` support)
- `npx tsx` (optional, for TypeScript scripts) — install globally: `npm i -g tsx`

## Setup

### 1. Clone or download the scripts

All `.ts` and `.js` files in this directory are self-contained. No `npm install` is needed — they use only Node.js built-in modules (`https`, `crypto`, `fs`, `path`).

### 2. Create credentials file

Create `phemex-credentials.json` in the project root:

```json
{
  "PHEMEX_API_KEY": "your-api-key-here",
  "PHEMEX_API_SECRET": "your-api-secret-here"
}
```

The API secret must be in **Base64url** encoding (as provided by Phemex).  
This file is already listed in `.gitignore` — it will not be committed.

> **Note:** For spot trading, the API key needs the "Spot" permission enabled in your Phemex account settings.

### 3. Make TypeScript scripts executable (optional)

```bash
chmod +x phemex-*.ts
```

Then you can run them as `./phemex-*.ts` instead of `npx tsx phemex-*.ts`.

---

## Scripts

### 🕐 `phemex-public-time.ts`

Fetches the Phemex server timestamp from the public API. No credentials needed.

```
npx tsx phemex-public-time.ts
```

**Output:**
```
Phemex server time:
  Timestamp:  1719876543210
  ISO:        2024-07-02T12:34:56.789Z
  Local:      7/2/2024, 2:34:56 PM
  UTC:        Tue, 02 Jul 2024 12:34:56 GMT
```

---

### 💰 `phemex-balances.js`

Retrieves balances across **all account types**:
- Spot Wallet
- USDT-M Perpetual (USDT, USD)
- Coin-M Perpetual (BTC, ETH, USD)

```
node phemex-balances.js
```

**Output:**
```
⟐ Spot Wallet ...
⟐ USDT-M Perpetual ...
⟐ Coin-M Perpetual ...

═══════════════════════════════════════
  Phemex Account Balances
═══════════════════════════════════════
  Account             Currency  Total          Available      Locked
  ────────────────────────────────────────────────────────────────────
  Spot                USDT           100.00          80.00         20.00
  USDT-M (USDT)       USDT          5000.00        4500.00        500.00
  Coin-M (BTC)        BTC              0.50           0.45          0.05
  ────────────────────────────────────────────────────────────────────
  TOTAL (USDT)        USDT          5100.00        4580.00        520.00
═══════════════════════════════════════
```

---

### 📋 `phemex-active-orders.ts`

Queries open (active) orders from Phemex. Supports querying a single symbol or scanning all symbols.

**By symbol:**
```
npx tsx phemex-active-orders.ts --symbol BTCUSD
npx tsx phemex-active-orders.ts --symbol BTCUSDT
```

**All accounts:**
```
npx tsx phemex-active-orders.ts --all
```

**Filter by account type:**
```
npx tsx phemex-active-orders.ts --all --account Coin-M
npx tsx phemex-active-orders.ts --all --account USDT-M
npx tsx phemex-active-orders.ts --all --account Spot
```

**Output (table with symbol, side, size, price, value, P&L, leverage, status):**
```
Symbol      Side    Size    Price           Value           P&L           Status
──────────────────────────────────────────────────────────────────────────
BTCUSD      Long      100  60000.00        100.0000        +5.0000      Open
ETHUSD      Short      50   3200.00         50.0000        -1.2000      Open
```

---

### ➕ `phemex-create-limit-order.ts`

Places a limit order on any account type. Automatically handles Phemex's value scaling (Ev).

```
./phemex-create-limit-order.ts --account <type> --symbol <pair> --side <Buy|Sell> --price <num> --qty <num> [options]
```

**Examples:**

| Account | Description | Command |
|---------|-------------|---------|
| **Spot** | Buy at $60k | `./phemex-create-limit-order.ts --account spot --symbol BTCUSDT --side Buy --price 60000 --qty 1` |
| **USDT-M** | Buy 100x Long | `./phemex-create-limit-order.ts --account usdt-m --symbol BTCUSDT --side Buy --price 60000 --qty 1 --leverage 100 --posSide Long` |
| **USDT-M** | Sell 100x Short | `./phemex-create-limit-order.ts --account usdt-m --symbol BTCUSDT --side Sell --price 63000 --qty 1 --leverage 100 --posSide Short` |
| **Coin-M** | Long 100x | `./phemex-create-limit-order.ts --account coin-m --symbol BTCUSD --side Long --price 6e4 --qty 1 --leverage 100` |
| **Coin-M** | Short 100x | `./phemex-create-limit-order.ts --account coin-m --symbol BTCUSD --side Short --price 6.3e4 --qty 1 --leverage 100` |

**Optional flags:**

| Flag | Description |
|------|-------------|
| `--posSide` | Position side for USDT-M only: `Merged` (default), `Long`, or `Short` |
| `--timeInForce` | `GoodTillCancel` (default), `PostOnly`, `ImmediateOrCancel`, `FillOrKill` |
| `--leverage` | Leverage for perpetual accounts (e.g. `100` = 100x, `0` = max cross-margin) |

> **Coin-M price format:** Use scientific notation like `6e4` (= 60,000) or `6.3e4` (= 63,000). The script converts these to the integer Ep (e.g. 600000000) expected by the API.

---

### ❌ `phemex-cancel-all-orders.ts`

Cancels **every open order** across all account types (or filtered by type).

```
npx tsx phemex-cancel-all-orders.ts
npx tsx phemex-cancel-all-orders.ts --account Coin-M
npx tsx phemex-cancel-all-orders.ts --account USDT-M
npx tsx phemex-cancel-all-orders.ts --account Spot
```

The script:
1. Fetches the product list to discover all active symbols
2. For each symbol, retrieves active orders
3. Cancels each order one by one

A progress line is printed after each cancellation. An `--account` flag is **required** to prevent accidental mass cancellation.

---

### 📊 `phemex-coinm-positions.ts`

Retrieves open **Coin-M (inverse perpetual)** positions for BTC, ETH, and USD settlement currencies.

```
npx tsx phemex-coinm-positions.ts
```

**Output:**
```
⟐  Coin-M (BTC) … 1 position(s) open
⟐  Coin-M (ETH) … 0 position(s) open
⟐  Coin-M (USD) … 0 position(s) open

Symbol      Side   Size   Entry Price    Value           P&L           Leverage   Liq. Price   Margin
────────────────────────────────────────────────────────────────────────────────────────────────────────
BTCUSD      Long      1   61000.00       1.000000       +0.050000       100.0     60500.00     0.010000
────────────────────────────────────────────────────────────────────────────────────────────────────────
```

---

### 📈 `phemex-ws-price.ts`

Real-time BTCUSD price ticker using the Phemex WebSocket API. Prints the last price to stdout whenever it changes, and prints a heart (`♥`) each time a heartbeat pong is received.

```
./phemex-ws-price.ts
```

**Features:**
- Subscribes to `market24h.subscribe` channel (updates every ~1s)
- Prints the current BTCUSD price only when the price **changes** (reduces noise)
- Heartbeat (`server.ping`) every 20 seconds, shown as `♥`
- **Auto-reconnects** on disconnect with exponential backoff (1s → 2s → 4s → … → 30s max)
- Clean shutdown on Ctrl+C (SIGINT)

**Output:**
```
7/4/2026, 5:30:00 PM  63452.00 ♥7/4/2026, 5:30:20 PM  63455.00 ♥7/4/2026, 5:30:40 PM  63450.00
```

---

### 🤖 `generate_commands.rb`

A Ruby script that generates and executes multiple limit orders programmatically. Useful for grid trading or batch order placement.

```
ruby generate_commands.rb
```

The script generates a set of short and long orders around a price range and calls `phemex-create-limit-order.ts` for each one.

**Customization:** Edit the `orders` array inside the script to define your own order grid (side, price, quantity, leverage).

---

## Credentials File Reference

All authenticated scripts expect `phemex-credentials.json` in the project root:

```json
{
  "PHEMEX_API_KEY": "00000000-0000-0000-0000-000000000000",
  "PHEMEX_API_SECRET": "ABC123...base64url-encoded-secret..."
}
```

| Field | Description |
|-------|-------------|
| `PHEMEX_API_KEY` | Your Phemex API key (UUID format) |
| `PHEMEX_API_SECRET` | Your Phemex API secret (Base64url encoded) |

**Security:** The credentials file is listed in `.gitignore` and will not be tracked by git.

---

## API Endpoints Used

| Script | Endpoint | Type |
|--------|----------|------|
| `phemex-public-time.ts` | `GET /public/time` | Public |
| `phemex-balances.js` | `GET /spot/wallets` | Signed |
| `phemex-balances.js` | `GET /g-accounts/accountPositions?currency=` | Signed |
| `phemex-balances.js` | `GET /accounts/accountPositions?currency=` | Signed |
| `phemex-active-orders.ts` | `GET /exchange/order/list` | Signed |
| `phemex-create-limit-order.ts` | `POST /exchange/order/place` | Signed |
| `phemex-create-limit-order.ts` | `PUT /g-accounts/leverage` | Signed |
| `phemex-create-limit-order.ts` | `PUT /accounts/leverage` | Signed |
| `phemex-cancel-all-orders.ts` | `DELETE /exchange/order/cancel` | Signed |
| `phemex-coinm-positions.ts` | `GET /accounts/accountPositions?currency=` | Signed |
| `phemex-ws-price.ts` | `wss://ws.phemex.com` | WebSocket |

---

## License

SPDX-License-Identifier: MIT
