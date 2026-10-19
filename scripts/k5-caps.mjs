// K5, the replay part: how the buy rules behave over the rehearsal pool (site/data/replay.json), using the
// program's own rules from site/core/chain.js (planBuy: slice, floor, guard, the three caps).
//
// The pool is replayed as the chain replay ticks it (a cranker inside the 30-second window, some missed
// ticks). The budget gains 0.99% of each bar's outside volume. After each landed boundary tick, one buy
// is planned at the boundary's price. The price-impact cap needs the pool's liquidity: the replayed pool
// is a constant-product PumpSwap pool, so its liquidity is the estimated SOL reserve over sqrt(price)
// (the reserve estimate replay.js uses for its 1% cap). Hunch's buys are not fed back into the prices.
// Reports how often each cap binds, how often the guard trips, and the share of the budget spent.
//
// Usage: node hunch/scripts/k5-caps.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createChain, adopt, tick, planBuy, SKIP, HOUR, MIN_HELD } from "../site/core/chain.js";
import { createReplay } from "../site/core/replay.js";
import { poolTimeline, standardMisses, testConfig } from "./pool-timeline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(here, "../site/data/replay.json"), "utf8"));
const bars = { t0: data.t0, close: data.close, vol: data.vol };
const tl = poolTimeline(bars, { missed: standardMisses(data.close.length, 17), seed: 11 });
const reserveAt = createReplay(data).reserveEstAt; // SOL reserve estimate per bar (constant product)

const S = createChain();
const cfg = testConfig(tl.activation);
adopt(S, { now: tl.adoptTs, cfg });

const name = Object.fromEntries(Object.entries(SKIP).map(([k, v]) => [v, k]));
let held = 0n, added = 0n, spent = 0n, lastFee = 0n;
const count = { hours: 0, buys: 0, skips: {}, binding: {}, errors: {} };
let lastBuyTs = 0;
for (const r of tl.ticks) {
  // the budget's share of what traded since the last landed tick
  const feeTotal = r.tradingQuoteFee + r.protocolQuoteFee;
  if (!r.missed) {
    const gained = ((r.creatorQuoteFee - (S._creatorSeen ?? 0n)));
    S._creatorSeen = r.creatorQuoteFee;
    held += gained; added += gained;
    const o = tick(S, { ...r, budgetWsol: held, creatorQuoteFee: 0n });
    lastFee = feeTotal;
    if (!o.boundary) continue;
    count.hours++;
    // the pool's liquidity now: reserve / sqrt(price), as DBC's L in Q64.64 terms
    const reserve = BigInt(Math.round(reserveAt(Math.max(0, r.b - 1)) * 1e9));
    const L = (reserve << 128n) / r.sqrtPrice;
    S.cfg = { ...cfg, sqrtStartPrice: 1n, curve: [{ sqrtPrice: 1n << 120n, liquidity: L }], migrationSqrtPrice: 1n << 120n, migrationQuoteThreshold: 1n << 62n };
    const now = r.now + 30;
    if (lastBuyTs && now - lastBuyTs < 1800) { count.errors.TooSoon = (count.errors.TooSoon ?? 0) + 1; continue; }
    const plan = planBuy(S, { now, held, sqrtPrice: r.sqrtPrice, quoteReserve: reserve });
    if (plan.dayReset) { S.buyDay = plan.day; S.dayBuys = 0; S.daySpent = 0n; S.dayCap = plan.dayCap; }
    if (plan.error) { count.errors[plan.error] = (count.errors[plan.error] ?? 0) + 1; continue; }
    if (plan.caps?.binding !== undefined) count.binding[name[plan.caps.binding]] = (count.binding[name[plan.caps.binding]] ?? 0) + 1;
    if (plan.skip !== undefined) { count.skips[name[plan.skip]] = (count.skips[name[plan.skip]] ?? 0) + 1; continue; }
    held -= plan.slice; spent += plan.slice;
    S.dayBuys++; S.daySpent += plan.slice; S.lastBuyHour = Math.floor(now / HOUR); S.lastBuyTs = now; lastBuyTs = now;
    count.buys++;
  }
}
const sol = (v) => (Number(v) / 1e9).toFixed(1);
console.log(`K5 replay over ${data.source.symbol} (${data.close.length} bars, ${count.hours} landed boundary ticks)`);
console.log(`  buys ${count.buys}; waited: ${JSON.stringify(count.skips)}; refused: ${JSON.stringify(count.errors)}`);
console.log(`  the cap that cut the slice: ${JSON.stringify(count.binding)} (of ${count.buys + Object.values(count.skips).reduce((a, b) => a + b, 0)} planned)`);
console.log(`  budget: gained ${sol(added)} SOL, spent ${sol(spent)} SOL = ${((100 * Number(spent)) / Number(added)).toFixed(1)}%, ${sol(held)} SOL waits at the end`);
console.log(`  minimum slice ${Number(MIN_HELD) / 1e9} SOL`);
