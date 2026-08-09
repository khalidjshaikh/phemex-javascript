// SPDX-License-Identifier: MIT
/**
 * closed-positions.ts — Shared library for reconstructing closed positions
 * from Phemex trade fills (USDT-M / exchange order v2 tradingList).
 *
 * The /g-accounts/accountPositions endpoint only reports currently open
 * positions; it does not reliably return closed ones.  Instead, this module
 * fetches executed fills and reconstructs closed round-trips with FIFO
 * lot matching:
 *
 *   Long  positions:  Buy fills open lots,  Sell fills close them.
 *   Short positions:  Sell fills open lots, Buy  fills close them.
 *
 * Each closing fill produces one ClosedPosition entry whose avg entry price
 * is the quantity-weighted average of the FIFO lots it consumed.  Realized
 * PnL (gross), entry/exit fees and net PnL are computed per round-trip.
 *
 * Usage:
 *   import { fetchFills, reconstructClosedPositions } from "./src/closed-positions.js";
 */

import { request } from "./http-client.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** One executed trade fill as returned by /exchange/order/v2/tradingList */
export interface Fill {
  symbol: string;
  side: number;            // 1 = Buy, 2 = Sell
  posSide?: number;        // 1 = Long, 2 = Short (when present)
  execQtyRq: number;       // executed qty in base currency
  execPriceRp: number;     // execution price (human-readable, Rp = real price)
  execFeeRv: number;       // fee in quote currency (USDT)
  createdAt?: string;      // ms epoch as string
  execId?: string;
  [key: string]: unknown;
}

/** A closed round-trip reconstructed from fills (FIFO lot matching). */
export interface ClosedPosition {
  symbol: string;
  posSide: "Long" | "Short";
  qty: number;             // base qty that was closed
  avgEntryPrice: number;   // qty-weighted avg of the FIFO lots consumed
  avgExitPrice: number;    // execution price of the closing fill
  realizedPnl: number;     // gross realized PnL (before fees)
  entryFee: number;        // fees paid by the opening fills (pro-rated)
  exitFee: number;         // fees paid by the closing fill
  netPnl: number;          // realizedPnl - entryFee - exitFee
  openedAt: number;        // ms epoch of the earliest consumed lot
  closedAt: number;        // ms epoch of the closing fill
}

export interface FillsOptions {
  symbol?: string;         // restrict to one symbol (e.g. XBRUSDT)
  currency?: string;       // default "USDT"
  days?: number;           // look-back window (default 7)
  limit?: number;          // max fills to fetch (default 200, pages of 200)
}

/* ------------------------------------------------------------------ */
/*  Fetch fills                                                        */
/* ------------------------------------------------------------------ */

/**
 * Fetch executed fills from /exchange/order/v2/tradingList, paging over
 * batches of 200 until `limit` rows are collected or the API reports the
 * end of data.  Throws on API errors.
 */
export async function fetchFills(
  apiKey: string,
  secretRaw: Buffer,
  opts: FillsOptions = {},
): Promise<Fill[]> {
  const {
    currency = "USDT",
    days = 7,
    limit = 200,
  } = opts;

  const pageSize = 200;
  const end = Date.now();
  const start = end - days * 86_400_000;

  const rows: Fill[] = [];
  let offset = 0;

  for (;;) {
    const pageLimit = Math.min(pageSize, limit - rows.length);
    if (pageLimit <= 0) break;

    const queryParts = [
      `currency=${currency}`,
      `start=${start}`,
      `end=${end}`,
      `offset=${offset}`,
      `limit=${pageLimit}`,
      `withCount=true`,
    ];
    if (opts.symbol) queryParts.unshift(`symbol=${opts.symbol}`);
    const query = queryParts.join("&");

    const resp = await request(
      "GET",
      "/exchange/order/v2/tradingList",
      query,
      apiKey,
      secretRaw,
      "",
    );

    if (resp.code !== 0) {
      throw new Error(`API error: ${String(resp.msg ?? resp.code)}`);
    }

    const data = resp.data as Record<string, unknown> | undefined;
    const pageRows = (data?.rows as Fill[] | undefined) ?? [];
    const total = Number(data?.total ?? rows.length + pageRows.length);
    rows.push(...pageRows);

    // Short page (or all rows collected) means we reached the end of data
    if (pageRows.length < pageLimit || rows.length >= total) break;
    offset += pageLimit;
  }

  return rows;
}

/* ------------------------------------------------------------------ */
/*  FIFO round-trip matching                                           */
/* ------------------------------------------------------------------ */

interface Lot {
  qty: number;
  origQty: number; // original fill qty, used to pro-rate fees on partial consumption
  price: number;
  fee: number;
  time: number;
}

/** Which fill sides open / close a position of the given posSide. */
function sidesFor(posSide: "Long" | "Short"): { open: number; close: number } {
  return posSide === "Long" ? { open: 1, close: 2 } : { open: 2, close: 1 };
}

function fillTime(f: Fill): number {
  if (f.createdAt) return Number(f.createdAt);
  const ns = f.transactTimeNs;
  if (typeof ns === "number" && ns > 0) return ns / 1_000_000;
  return 0;
}

/**
 * Reconstruct closed positions from a list of fills using FIFO lot
 * matching, separately per (symbol, posSide).  posSide is taken from the
 * fill when available; otherwise inferred from side (Buy → Long,
 * Sell → Short).
 *
 * @param fills  Fills in chronological order (they are sorted internally).
 */
export function reconstructClosedPositions(fills: Fill[]): ClosedPosition[] {
  const sorted = [...fills].sort((a, b) => fillTime(a) - fillTime(b));

  // key: `${symbol}|${posSide}`
  const openLots = new Map<string, Lot[]>();
  const closed: ClosedPosition[] = [];

  const lotKey = (symbol: string, posSide: "Long" | "Short") =>
    `${symbol}|${posSide}`;

  for (const f of sorted) {
    const posSide: "Long" | "Short" =
      f.posSide === 2 ? "Short" : f.posSide === 1 ? "Long" : f.side === 2 ? "Short" : "Long";
    const { open, close } = sidesFor(posSide);
    const qty = Number(f.execQtyRq) || 0;
    const price = Number(f.execPriceRp) || 0;
    const fee = Number(f.execFeeRv) || 0;
    const time = fillTime(f);
    const key = lotKey(f.symbol, posSide);

    if (qty <= 0 || price <= 0) continue;

    if (f.side === open) {
      // Opening fill → push onto the FIFO queue
      const lots = openLots.get(key) ?? [];
      lots.push({ qty, origQty: qty, price, fee, time });
      openLots.set(key, lots);
      continue;
    }

    if (f.side !== close) continue; // unknown side — ignore

    // Closing fill → consume FIFO lots until the close qty is satisfied
    const lots = openLots.get(key) ?? [];
    let remaining = qty;
    let consumed: Lot[] = [];

    while (remaining > 1e-12 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(lot.qty, remaining);
      consumed.push({ ...lot, qty: take });
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 1e-12) lots.shift();
    }
    if (consumed.length === 0) continue; // closing without an open lot (e.g. old history)

    const totalQty = consumed.reduce((s, l) => s + l.qty, 0);
    const avgEntry = consumed.reduce((s, l) => s + l.price * l.qty, 0) / totalQty;
    const entryFee = consumed.reduce(
      (s, l) => s + (l.fee * l.qty) / l.origQty,
      0,
    );
    const openedAt = consumed.reduce((s, l) => Math.min(s, l.time), Infinity);
    const realizedPnl =
      posSide === "Long"
        ? (price - avgEntry) * totalQty
        : (avgEntry - price) * totalQty;

    closed.push({
      symbol: f.symbol,
      posSide,
      qty: totalQty,
      avgEntryPrice: avgEntry,
      avgExitPrice: price,
      realizedPnl,
      entryFee,
      exitFee: fee,
      netPnl: realizedPnl - entryFee - fee,
      openedAt: openedAt === Infinity ? time : openedAt,
      closedAt: time,
    });
  }

  return closed;
}
