# EMA Crossover Trading Bot — Plan

## File
`./phemex-ws-ema-crossover.ts`

## Strategy
- **Entry (LONG):** EMA20 crosses above EMA50 **AND** Price > EMA200
- **Entry (SHORT):** EMA20 crosses below EMA50 **AND** Price < EMA200
- **Exit / flip:** On crossover, close current position; open opposite only if EMA200 filter allows, otherwise go flat (NONE)

## State machine

| Current | Crossover | Condition | Actions | New |
|---|---|---|---|---|
| NONE | EMA20 ↑ EMA50 | Price > EMA200 | go LONG | LONG |
| NONE | EMA20 ↑ EMA50 | Price ≤ EMA200 | — | NONE |
| NONE | EMA20 ↓ EMA50 | Price < EMA200 | go SHORT | SHORT |
| NONE | EMA20 ↓ EMA50 | Price ≥ EMA200 | — | NONE |
| LONG | EMA20 ↓ EMA50 | Price < EMA200 | close LONG, open SHORT | SHORT |
| LONG | EMA20 ↓ EMA50 | Price ≥ EMA200 | close LONG | NONE |
| SHORT | EMA20 ↑ EMA50 | Price > EMA200 | close SHORT, open LONG | LONG |
| SHORT | EMA20 ↑ EMA50 | Price ≤ EMA200 | close SHORT | NONE |

## Output

### 1s display line
```
· 19:30:01  Price: 58432.10  EMA20: 58390.45  EMA50: 58210.33  EMA200: 58000.00  Position: LONG  [ticks: 312]
```

### Signal line (on crossover action)
```
[SIGNAL] 2026-07-04 19:30:01  go LONG       NONE →  LONG   Price: 58432.10  EMA20: 58390  EMA50: 58210  EMA200: 58000
```

## Reuse from `phemex-ws-ema.ts`
- `EMACalculator` class (keep EMA20, EMA50, EMA200 — EMA200 used only as filter)
- WebSocket connect / heartbeat / reconnect / SIGINT + price persistence
- 1s `tickDisplay` timer (augment with position state)

## What's new
- Crossover detection (prev EMA20 vs prev EMA50 comparison)
- `Position` type (`"NONE" | "LONG" | "SHORT"`)
- `evaluateCrossover()` function — called on every ticker message
- EMA200 trend filter check
- Signal action output

## Not included
- Actual order placement on Phemex (prints only)
- Risk management / position sizing
- Account balance checks
