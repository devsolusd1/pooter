// Cranker strategies for kill test K7: what a cranker who controls when (and whether) ticks land can do
// to the record, with the program's own rules (site/core/chain.js, which the LiteSVM replay proves equal
// to the program on every tick).
//
// The pool reading at any second comes from the coin's 5-minute candles (the finest data we hold):
// volume inside a candle is spread evenly over its 300 seconds, and sqrt_price moves linearly from the
// candle's open to its close. So the second a tick lands changes what it reads, which is the lever the
// "choose the best second" attack pulls. This is a model of intra-candle trading, not 1-minute data.
//
// Two kinds of strategy. A realizable one uses only what a cranker can know when it sends the tick: the
// counters and prices so far (so the outcome of the hour that just ended, at every second of the window),
// and what the network and the one-line rule would call. An oracle one also knows the next hour's trades
// (it clones the program state and runs the real rules forward): only someone who controls the next
// hour's volume has that, so its gains are upper bounds.

import { createChain, adopt, tick, OUTCOME, CALL, WINDOW } from "../site/core/chain.js";
import { sqrtPriceOf, FEE_NUM, PROTOCOL_PCT, CREATOR_PCT, testConfig } from "./pool-timeline.mjs";

export const BAR = 600, H = 6;
export { WINDOW }; // the program's window (site/core/chain.js)

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
}

// rows: [ts, open, high, low, close, volume in SOL] five-minute candles, ascending.
// Returns { t0, nb, at(now) } where at(now) is what the pool account would hold at second `now`.
export function readingModel(rows, { quoteReserve = 10_000_000_000n } = {}) {
  const t0 = Math.floor(rows[0][0] / BAR) * BAR;
  const nb = Math.floor((Math.floor(rows.at(-1)[0] / BAR) * BAR - t0) / BAR) + 1;
  const ts = rows.map((r) => r[0]);
  const lam = rows.map((r) => BigInt(Math.round(r[5] * 1e9)));
  const pre = [0n];
  for (const l of lam) pre.push(pre[pre.length - 1] + l);
  const spOpen = rows.map((r) => sqrtPriceOf(r[1])), spClose = rows.map((r) => sqrtPriceOf(r[4]));
  const last = (now) => { // the last candle starting at or before now
    let lo = 0, hi = ts.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= now) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  function at(now) {
    const i = last(now);
    let V = 0n, sp = spOpen[0];
    if (i >= 0) {
      const into = Math.min(300, now - ts[i]);
      V = pre[i] + (lam[i] * BigInt(into)) / 300n;
      sp = into >= 300 ? spClose[i] : spOpen[i] + ((spClose[i] - spOpen[i]) * BigInt(into)) / 300n;
    }
    const fee = (V * FEE_NUM) / 1_000_000_000n;
    const protocol = (fee * PROTOCOL_PCT) / 100n, trading = fee - protocol;
    return { sqrtPrice: sp, tradingQuoteFee: trading, protocolQuoteFee: protocol, creatorQuoteFee: (trading * CREATOR_PCT) / 100n, quoteReserve, budgetWsol: 0n };
  }
  return { t0, nb, at };
}

// A deep copy that keeps classes (Net, Weights), Maps and typed arrays.
export function clone(v) {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, clone(x)]));
  if (ArrayBuffer.isView(v)) return v.slice();
  if (Array.isArray(v)) return v.map(clone);
  const o = Object.create(Object.getPrototypeOf(v));
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
}

// The published history (tape, diary, records) is not read by scoring: keep it short so clones are cheap.
function trim(S) {
  if (S.tape.length > 12) S.tape = S.tape.slice(-12);
  if (S.diary.length) S.diary = [];
  if (S.records.size) S.records = new Map();
}

// strategies that need the future (upper bounds); the rest are realizable
export const ORACLE = new Set(["best-second-ahead", "skip-oracle-ordinary", "skip-ordinary-best-second", "skip-oracle-free"]);

export const STRATEGIES = {
  honest: "every bar at a random second 0-29 (the reference)",
  "second-0": "every bar at second 0",
  "best-second": `each boundary at the second (0-${WINDOW - 1}) that makes the hour just ended a hit`,
  "worst-second": "each boundary at the second that makes it a miss (the size of the lever)",
  "best-second-ahead": "each boundary at the second (every 3 s) that makes the ended hour a hit and, looking one hour ahead, the new call a hit",
  "skip-oracle-boundary": "skips a boundary tick whenever it would score a miss",
  "skip-quieter": "skips the boundary tick that ends an hour called quieter (once; the next one lands)",
  "skip-random-10": "skips 10% of boundary ticks at random",
  "skip-oracle-ordinary": "before each boundary, skips the ordinary tick just before it when that makes the next call a hit",
  "skip-ordinary-best-second": "skip-oracle-ordinary and best-second-ahead together",
  "steer-rule-second": "no oracle: each boundary at the second (every 3 s) whose new call agrees with the one-line rule",
  "steer-rule-skip": "no oracle: skips the ordinary tick before a boundary when that makes the call agree with the one-line rule",
  "skip-oracle-free": "skips any ordinary tick when, looking two hours ahead, that wins more hits than it forfeits",
};

// Runs one coin under a strategy. Returns { S, schedule } where schedule lists every bar's tick as the
// program would see it ({ b, now, slot, missed, ...reading }), ready for the chain-replay vectors.
export function runCrank(model, strategy, { seed = 11, window = WINDOW, gapRule = true, maxChapter = 3 } = {}) {
  const { t0, nb, at } = model;
  const rnd = lcg(seed), rnd2 = lcg(seed * 7 + 3);
  const honestSec = Array.from({ length: nb }, () => rnd() % Math.min(30, window));
  const reading = (b, sec) => { const now = t0 + b * BAR + sec; return { ...at(now), now, slot: BigInt(1_000_000 + b * 1500 + sec) }; };
  const S = createChain({ gapRule, maxChapter });
  adopt(S, { now: t0 - 300, cfg: testConfig(t0 - 400) });
  const schedule = [];
  const land = (b, sec) => { const r = reading(b, sec); tick(S, r); trim(S); schedule.push({ b, missed: false, ...r }); };
  const miss = (b) => schedule.push({ b, missed: true, ...reading(b, honestSec[b]) });
  // the outcome a boundary tick at `sec` would score, on a copy
  const outcomeAt = (state, b, sec) => { const C = clone(state); const o = tick(C, reading(b, sec)); return { C, o, outcome: o.scoring ? o.scoring.outcome : OUTCOME.NONE }; };
  // runs a copy honestly through bar `to` (inclusive) and returns the outcome scored at `to` (a boundary)
  const honestUntil = (C, from, to) => {
    let out = null;
    for (let k = from; k <= to && k < nb; k++) { out = tick(C, reading(k, honestSec[k])); trim(C); }
    return out && out.scoring ? out.scoring.outcome : OUTCOME.NONE;
  };
  // bar b is a boundary when its absolute bar number starts a UTC hour (t0 need not start one)
  const off = (t0 / BAR) % H;
  const isBoundary = (b) => (b + off) % H === 0;
  // hits scored by the boundaries in bars from..to, running a copy honestly
  const hitsUntil = (C, from, to) => {
    let hits = 0;
    for (let k = from; k <= to && k < nb; k++) { const o = tick(C, reading(k, honestSec[k])); trim(C); if (o.scoring && o.scoring.outcome === OUTCOME.HIT) hits++; }
    return hits;
  };
  const skipFree = (b) => {
    const nextB = b + (H - ((b + off) % H)), to = nextB + 2 * H;
    if (to >= nb || S.ticks === 0) return false;
    const A = clone(S), B = clone(S);
    const honest = hitsUntil(A, b, to), skipped = hitsUntil(B, b + 1, to);
    return skipped > honest;
  };
  // the skip-ordinary oracle: decide at bar b (the ordinary bar before boundary b + 1)
  const skipOrdinary = (b) => {
    const nb1 = b + 1, next = b + 1 + H;
    if (next >= nb || S.ticks === 0) return false;
    const A = clone(S); tick(A, reading(b, honestSec[b])); trim(A); tick(A, reading(nb1, honestSec[nb1])); trim(A);
    const hitA = honestUntil(A, nb1 + 1, next) === OUTCOME.HIT;
    if (hitA) return false;
    const B = clone(S); tick(B, reading(nb1, honestSec[nb1])); trim(B);
    return honestUntil(B, nb1 + 1, next) === OUTCOME.HIT;
  };
  const bestSecondAhead = (b) => {
    let best = honestSec[b], bestScore = -1;
    const cands = [honestSec[b], ...Array.from({ length: Math.ceil(window / 3) }, (_, i) => i * 3)];
    for (const sec of cands) {
      const { C, outcome } = outcomeAt(S, b, sec);
      trim(C);
      const now = outcome === OUTCOME.HIT ? 2 : 0;
      if (now + 1 <= bestScore) continue;
      const ahead = b + H < nb ? (honestUntil(C, b + 1, b + H) === OUTCOME.HIT ? 1 : 0) : 0;
      if (now + ahead > bestScore) { bestScore = now + ahead; best = sec; }
    }
    return best;
  };
  for (let b = 0; b < nb; b++) {
    const boundary = isBoundary(b);
    if (S.ticks === 0 || b < 2 * H) { land(b, strategy === "second-0" ? 0 : honestSec[b]); continue; }
    switch (strategy) {
      case "honest": land(b, honestSec[b]); break;
      case "second-0": land(b, 0); break;
      case "best-second":
      case "worst-second": {
        if (!boundary) { land(b, honestSec[b]); break; }
        const want = strategy === "best-second" ? OUTCOME.HIT : OUTCOME.MISS;
        let pick = honestSec[b];
        if (outcomeAt(S, b, pick).outcome !== want) {
          for (let sec = 0; sec < window; sec++) if (outcomeAt(S, b, sec).outcome === want) { pick = sec; break; }
        }
        land(b, pick);
        break;
      }
      case "best-second-ahead": land(b, boundary ? bestSecondAhead(b) : honestSec[b]); break;
      case "skip-oracle-boundary":
        if (boundary && outcomeAt(S, b, honestSec[b]).outcome === OUTCOME.MISS) miss(b); else land(b, honestSec[b]);
        break;
      case "skip-quieter":
        if (boundary && S.signal.call === CALL.QUIETER && S.lastBoundaryHour === Math.floor((t0 + b * BAR) / 3600) - 1) miss(b); else land(b, honestSec[b]);
        break;
      case "steer-rule-second": {
        if (!boundary) { land(b, honestSec[b]); break; }
        let pick = honestSec[b];
        const agrees = (sec) => { const { C } = outcomeAt(S, b, sec); return C.signal.call !== CALL.NONE && C.signal.call === C.signal.rule; };
        if (!agrees(pick)) for (let sec = 0; sec < window; sec += 3) if (agrees(sec)) { pick = sec; break; }
        land(b, pick);
        break;
      }
      case "steer-rule-skip": {
        if (!isBoundary(b + 1) || S.ticks === 0) { land(b, honestSec[b]); break; }
        const A = clone(S); tick(A, reading(b, honestSec[b])); tick(A, reading(b + 1, honestSec[b + 1]));
        if (A.signal.call === A.signal.rule) { land(b, honestSec[b]); break; }
        const B = clone(S); tick(B, reading(b + 1, honestSec[b + 1]));
        if (B.signal.call !== CALL.NONE && B.signal.call === B.signal.rule) miss(b); else land(b, honestSec[b]);
        break;
      }
      case "skip-oracle-free":
        if (!boundary && skipFree(b)) miss(b); else land(b, honestSec[b]);
        break;
      case "skip-random-10":
        if (boundary && rnd2() % 10 === 0) miss(b); else land(b, honestSec[b]);
        break;
      case "skip-oracle-ordinary":
        if (isBoundary(b + 1) && skipOrdinary(b)) miss(b); else land(b, honestSec[b]);
        break;
      case "skip-ordinary-best-second":
        if (isBoundary(b + 1) && skipOrdinary(b)) miss(b);
        else land(b, boundary ? bestSecondAhead(b) : honestSec[b]);
        break;
      default: throw new Error(`unknown strategy ${strategy}`);
    }
  }
  return { S, schedule };
}

// The record of a finished run: the network, the one-line rule, the majority side and the luck band.
export function recordOf(S) {
  const n = S.n, scored = S.n - S.forfeits;
  const busier = S.busierHours, quieter = scored - busier;
  const band = 1.96 * Math.sqrt(0.25 / Math.max(1, n));
  return {
    n, hits: S.hits, rule: S.ruleHits, forfeits: S.forfeits, notScored: S.notScored, busier, quieter,
    net: S.hits / n, ruleAcc: S.ruleHits / n, majority: Math.max(busier, quieter) / n, band,
  };
}
