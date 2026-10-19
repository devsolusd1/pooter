// Hunch's program rules, the curve phase and the pool phase, in JavaScript, integer for integer: the
// reference the Solana program (programs/hunch) must match on every tick (its LiteSVM replays check the
// calls, the scores, the open call, the diary and the weights against this file, on the curve and, after
// adopt_pool, on a DAMM v2 pool with Meteora changing the fee and pausing the pool).
//
// What a tick reads is what the program reads from the Meteora DBC pool: sqrt_price (u128, Q64.64),
// metrics.total_trading_quote_fee + metrics.total_protocol_quote_fee (u64 counters), the live base
// fee from the config's 5-second opening schedule, and Hunch's own fee and price move recorded by its
// buys. After graduation (adoptPool) it reads the DAMM v2 pool: sqrt_price, metrics.total_lp_b_fee +
// total_protocol_b_fee, the liquidity, the pool status and the fee fields (fingerprinted: an hour in which
// Meteora changed the fee or paused the pool, or the hour it is compared against, is not scored).
// Everything here is BigInt or safe integers; no floats touch a decision.

import { Net, Weights, ONE, H, SEED, chapterOf, leanBps, N_WEIGHTS_V1 } from "./net.js";
import { sha256, toHex } from "./sha256.js";

// ---------- constants (the Rust program has the same, in programs/hunch/src/rules.rs) ----------
export const BAR = 600;                 // a bar is 10 minutes
export const WINDOW = 30;               // a tick lands only in the first 30 seconds of a bar
export const HOUR = 3600;
export const DAY = 86400;
export const FEE_DENOM = 1_000_000_000n; // DBC fee numerator scale
export const OPENING_SECONDS = 5;       // the opening fee falls to 3.75% over 5 seconds
export const WARM_HOURS = 3;            // hours from the first tick's hour before any hour is owed a score
export const MAX_FILL = 12;             // missed bars filled at most (two hours of history)
export const LEAN_STRONG = 5500;        // a lean of at least 55/45 moves the multiplier
export const MIN_HELD = 10_000_000n;    // 0.01 SOL: below it the budget waits; the slice floor
export const DAY_MAX_BUYS = 24;
export const DAY_CAP_BPS = 2000n;       // 20% of the pool's SOL side per UTC day
export const DAY_CAP_FLOOR = 1_000_000_000n; // ... with a floor of 1 SOL
export const VOLUME_CAP_DIV = 4n;       // 25% of the previous hour's outside volume
export const GUARD_BPS = 500;           // no buy if spot is more than 5% over the median of 6 samples
export const GUARD_SAMPLES = 6;
export const GUARD_STALE = 1200;        // ... or the newest sample is over 20 minutes old
export const BUY_GAP = 1800;            // at least 30 minutes between buys
export const IMPACT_SQRT_BPS = 100n;    // a buy moves sqrt_price by at most 1% (price about 2.01%)
export const POST_SWAP_NUM = 10101n, POST_SWAP_DEN = 10000n; // revert if sqrt_price rose more than 1.0101x
export const MIN_OUT_BPS = 9900n;       // min_out = 99% of the program's own quote
export const Q32 = 1n << 32n;
// the pool phase (Meteora DAMM v2, after graduation; rules.rs pool_phase)
export const POOL_WARM_HOURS = 2;       // the adoption hour and the next are not owed a score
export const MIN_POSITION_PCT = 25n;    // adopt_pool: Hunch's position holds, locked for good, >= 25% of the migration's liquidity
export const DAMM_MIN_SQRT_PRICE = 4295048016n; // DAMM v2's lowest sqrt price: the lower end of the migrated full-range pool
export const MAX_FEE_NUMERATOR_V0 = 500_000_000n, MAX_FEE_NUMERATOR_V1 = 990_000_000n;
export const DIST = { FEE: 1, PAUSE: 2 }; // what Meteora did in a boundary interval
export const GRADUATION_LINE = "graduated: it now learns from its Meteora DAMM v2 pool, with a new record.";
export const DAMM_FEE_BYTES = 75;       // the fee fields a tick fingerprints: pool[8..80] ++ pool[484..487]

// phases, calls, outcomes
export const PHASE = { SETUP: 0, CURVE: 1, GRADUATING: 2, POOL: 3, BLIND: 4 };
export const CALL = { NONE: 0, QUIETER: 1, BUSIER: 2 };
export const OUTCOME = { NONE: 0, HIT: 1, MISS: 2, FORFEIT: 3, NOT_SCORED: 4 };
// diary flags (u16)
export const DF = {
  FORFEIT: 1 << 0, NO_OUTSIDE: 1 << 1, GUARD: 1 << 2, BELOW_MIN: 1 << 3, VOLUME_CAP: 1 << 4,
  FEE_CHANGED: 1 << 5, PAUSED: 1 << 6, GRADUATING: 1 << 7, BLIND: 1 << 8, WARMUP: 1 << 9,
  DAY_RECORD: 1 << 10, TIE: 1 << 11, NO_ATTEMPT: 1 << 12, STALE: 1 << 13, DAY_CAP: 1 << 14, CHAPTER: 1 << 15,
};
// open-call flags (u8)
// GAP: a tick in the hour before this boundary was missed, so no call was made (the hour is forfeited)
export const SF = { FEE_CHANGED: 1, PAUSED: 2, GUARD: 4, VOLUME_CAP: 8, BLIND: 16, WARMUP: 32, GAP: 64 };
// tape flags (u16)
export const TF = { BASELINE: 1, BOUNDARY: 2, GAP: 4, BLIND: 8, LEARNED: 16, BUSIER: 32, HAS_CALL: 64, DAY_RECORD: 128 };
// why a buy waited (state.hourStatus.reason)
export const SKIP = { NONE: 0, BELOW_MIN: 1, GUARD: 2, STALE: 3, VOLUME_CAP: 4, DAY_CAP: 5, IMPACT_CAP: 6 };
// the coin's ticker, set once by initialize (State.ticker): 1 to 10 characters, A-Z and 0-9
export const TICKER_MAX = 10;
export const tickerOk = (t) => typeof t === "string" && /^[A-Z0-9]{1,10}$/.test(t);

// ---------- integer helpers ----------
const big = (v) => BigInt(v);
const minB = (a, b) => (a < b ? a : b);
const maxB = (a, b) => (a > b ? a : b);
const bitLen = (v) => v.toString(2).length;
export const U64_MAX = (1n << 64n) - 1n;
const sat64 = (v) => (v > U64_MAX ? U64_MAX : v);

// sqrt(a) / sqrt(b) as a Q32.32 ratio of sqrt prices, floored; both scaled down together so a << 32
// stays inside 128 bits.
export function ratioQ32(a, b) {
  const m = maxB(a, b);
  const bits = bitLen(m);
  if (bits > 96) { const s = big(bits - 96); a >>= s; b >>= s; }
  if (b === 0n) return Q32;
  return (a << 32n) / b;
}
// A sqrt-price ratio (Q32.32) to the price return in Q16.16: ratio^2 - 1, the ratio clamped to [0, 3].
export function retFromRatio(rq) {
  const c = minB(rq, 3n * Q32);
  return Number((c * c) >> 48n) - ONE;
}
// The live base fee numerator of a linear fee scheduler at `now` (DBC's FeeScheduler::Linear).
export function liveFeeNumerator(cfg, now) {
  if (cfg.periodFrequency === 0n) return cfg.cliffFeeNumerator;
  let period = (big(now) - cfg.activationPoint) / cfg.periodFrequency;
  if (period < 0n) period = 0n;
  if (period > cfg.numberOfPeriod) period = cfg.numberOfPeriod;
  return cfg.cliffFeeNumerator - cfg.reductionFactor * period;
}
export const feeBps = (feeNum) => Number(feeNum / 100_000n);

// 1.96 x sqrt(0.25 / n) in basis points: 9800 / sqrt(n), from an integer square root.
export function isqrt(v) {
  if (v < 2n) return v;
  let x = 1n << big(Math.ceil(bitLen(v) / 2));
  for (;;) { const y = (x + v / x) >> 1n; if (y >= x) return x; x = y; }
}
export function luckBandBps(n) {
  if (n <= 0) return 0;
  const r = isqrt(big(n) << 32n); // sqrt(n) x 2^16
  return Number((9800n << 16n) / r);
}

// ---------- DBC curve math (as the program does it) ----------
// segments: [{ lower, upper, liquidity }] from the config's sqrt_start_price and curve points
export function curveSegments(cfg) {
  const segs = [];
  let lower = cfg.sqrtStartPrice;
  for (const p of cfg.curve) {
    if (p.sqrtPrice === 0n || p.liquidity === 0n) break;
    segs.push({ lower, upper: p.sqrtPrice, liquidity: p.liquidity });
    lower = p.sqrtPrice;
  }
  return segs;
}
// The SOL that moves sqrt_price from sp up by IMPACT_SQRT_BPS, with the smallest liquidity among the
// segments the range touches: L_min x (target - sp) / 2^128, rounded down. Segments past the migration
// price are never traded and do not count; a slice that goes past it completes the curve (partial fill).
export function impactCap(sp, cfg) {
  const target = sp + (sp * IMPACT_SQRT_BPS) / 10000n;
  const stop = cfg.migrationSqrtPrice;
  const reach = stop !== 0n && stop < target ? stop : target;
  let minL = null;
  for (const s of curveSegments(cfg)) {
    if (s.upper > sp && s.lower < reach) minL = minL === null ? s.liquidity : minB(minL, s.liquidity);
  }
  if (minL === null) return 0n;
  return sat64((minL * (target - sp)) >> 128n);
}
// DBC ExactIn quote to base (QuoteToken fee mode, fee on input), stopping at the migration price.
export function quoteBuy(sp, cfg, feeNum, amountIn) {
  const fee = (amountIn * feeNum + FEE_DENOM - 1n) / FEE_DENOM;
  let left = amountIn - fee, cur = sp, out = 0n;
  const stop = cfg.migrationSqrtPrice;
  for (const p of cfg.curve) {
    if (p.sqrtPrice === 0n || p.liquidity === 0n) break;
    const ref = minB(stop, p.sqrtPrice);
    if (ref <= cur) continue;
    const L = p.liquidity;
    const maxIn = (L * (ref - cur) + (1n << 128n) - 1n) >> 128n;
    if (left < maxIn) {
      const next = cur + (left << 128n) / L;
      out += (L * (next - cur)) / (cur * next);
      cur = next; left = 0n;
      break;
    }
    out += (L * (ref - cur)) / (cur * ref);
    cur = ref; left -= maxIn;
    if (ref === stop) break;
  }
  return { out, nextSqrtPrice: cur, partial: left > 0n, fee };
}

// ---------- DAMM v2 (the pool after graduation) ----------
const U128_MAX = (1n << 128n) - 1n;
const sat128 = (v) => (v > U128_MAX ? U128_MAX : v);
// DAMM v2's variable fee: ceil((volatility_accumulator x bin_step)^2 x variable_fee_control / 1e11), saturating
export function dammVariableFee(volAcc, binStep, control) {
  const vb = sat128(big(volAcc) * big(binStep));
  const sq = sat128(vb * vb);
  const v = sat128(sq * big(control));
  return sat128(v + 99_999_999_999n) / 100_000_000_000n;
}
// The fee fields a tick reads (feeBytes = pool[8..80] ++ pool[484..487], 75 bytes) and the live volatility
// accumulator: the numerator DAMM v2 charges now, and whether it is "plain" (a static base fee, no dynamic
// fee), the only kind Hunch scores hours under.
export function dammFeeOf(feeBytes, volatilityAccumulator = 0n) {
  const v = new DataView(feeBytes.buffer, feeBytes.byteOffset, feeBytes.length);
  const f = {
    cliff: v.getBigUint64(0, true), mode: feeBytes[8], nPeriods: v.getUint16(14, true), frequency: v.getBigUint64(16, true),
    reduction: v.getBigUint64(24, true), dynamic: feeBytes[48] !== 0, variableFeeControl: v.getUint32(60, true),
    binStep: v.getUint16(64, true), feeVersion: feeBytes[74],
  };
  const plain = (f.mode === 0 || f.mode === 1) && (f.nPeriods === 0 || f.frequency === 0n || f.reduction === 0n) && !f.dynamic;
  const max = f.feeVersion === 0 ? MAX_FEE_NUMERATOR_V0 : MAX_FEE_NUMERATOR_V1;
  const varFee = f.dynamic ? dammVariableFee(volatilityAccumulator, f.binStep, f.variableFeeControl) : 0n;
  const total = f.cliff + varFee;
  return { ...f, plain, numerator: total > max ? max : total };
}
// The fee configuration as 8 bytes: the first 8 bytes of SHA-256(feeBytes), little-endian.
export function feeFingerprint(feeBytes) {
  const h = sha256(feeBytes);
  return new DataView(h.buffer, h.byteOffset, 8).getBigUint64(0, true);
}
// Builds the 75 fee bytes of a DAMM v2 pool (vectors and tests): a time-scheduler base fee, the fee split,
// the dynamic fee's switch and parameters, then collect mode, pool type and fee version.
export function dammFeeBytes({
  cliff, mode = 0, nPeriods = 0, frequency = 0n, reduction = 0n, protocolPct = 20, referralPct = 20, compoundingBps = 0,
  dynamic = false, maxVolatilityAccumulator = 0, variableFeeControl = 0, binStep = 0, filterPeriod = 0, decayPeriod = 0,
  reductionFactor = 0, collectFeeMode = 1, poolType = 1, feeVersion = 1,
}) {
  const b = new Uint8Array(DAMM_FEE_BYTES), v = new DataView(b.buffer);
  v.setBigUint64(0, big(cliff), true); b[8] = mode; v.setUint16(14, nPeriods, true);
  v.setBigUint64(16, big(frequency), true); v.setBigUint64(24, big(reduction), true);
  b[40] = protocolPct; b[42] = referralPct; v.setUint16(46, compoundingBps, true);
  b[48] = dynamic ? 1 : 0; v.setUint32(56, maxVolatilityAccumulator, true); v.setUint32(60, variableFeeControl, true);
  v.setUint16(64, binStep, true); v.setUint16(66, filterPeriod, true); v.setUint16(68, decayPeriod, true); v.setUint16(70, reductionFactor, true);
  b[72] = collectFeeMode; b[73] = poolType; b[74] = feeVersion;
  return b;
}
// The impact cap on DAMM v2 (one full-range position): L x (1% of sqrt_price) / 2^128, with L the smaller of
// the liquidity at the last tick and the live liquidity.
export function poolImpactCap(sp, liquidity, sqrtMax) {
  return impactCap(big(sp), { sqrtStartPrice: 0n, migrationSqrtPrice: 0n, curve: [{ sqrtPrice: big(sqrtMax), liquidity: big(liquidity) }] });
}
// DAMM v2's ExactIn quote, SOL in, HUNCH out, fee on the way in (OnlyB): one DBC segment's arithmetic.
export function quotePoolBuy(sp, liquidity, sqrtMax, feeNum, amountIn) {
  return quoteBuy(big(sp), { migrationSqrtPrice: big(sqrtMax), curve: [{ sqrtPrice: big(sqrtMax), liquidity: big(liquidity) }] }, big(feeNum), big(amountIn));
}
// buy_and_burn_pool refuses (FeeRaised, the program's error 30) a fee Hunch cannot model (a dynamic fee, a fee
// schedule still running) or one above the fee at adoption; a lower fee is not refused. fee = dammFeeOf(...).
// Mirrors pool_fee_refused in rules.rs.
export const poolFeeRefused = (fee, adoptFeeNum) => !fee.plain || fee.numerator > big(adoptFeeNum);
// adopt_pool's bar. The full-range DAMM v2 liquidity that `quote` lamports make at `sqrtPrice`
// (amount_b = L x (sqrt_price - sqrt_min) / 2^128, so L = quote x 2^128 / (sqrt_price - sqrt_min), floored;
// null at or below the minimum sqrt price or above 128 bits). With the DBC config's migration threshold and
// migration sqrt price (pinned by adopt_curve) it is the liquidity DBC's migration builds, which no outsider can
// change. The position passes with some liquidity locked for good and at least 25% of it (DBC gives the creator
// 33%). Mirrors migration_liquidity and position_share_ok in rules.rs.
export function migrationLiquidity(quote, sqrtPrice) {
  const sp = big(sqrtPrice);
  if (sp <= DAMM_MIN_SQRT_PRICE) return null;
  const l = (big(quote) << 128n) / (sp - DAMM_MIN_SQRT_PRICE);
  return l > U128_MAX ? null : l;
}
export function positionShareOk(locked, quote, sqrtPrice) {
  const l = migrationLiquidity(quote, sqrtPrice);
  return l !== null && big(locked) > 0n && big(locked) * 100n >= l * MIN_POSITION_PCT;
}
// What a tick on DAMM v2 counts as fees: metrics.total_lp_b_fee (u128, read as u64) + total_protocol_b_fee.
export function dammFeeTotal(r) {
  return sat64(minB(big(r.lpBFee), U64_MAX) + big(r.protocolBFee));
}

// ---------- formatting (the diary line) ----------
function u64dec(v) { return big(v).toString(); }
// lamports to "0.083" (3 decimals, truncated)
export function fmtSol3(lamports) {
  const l = big(lamports);
  const whole = l / 1_000_000_000n, frac = (l % 1_000_000_000n) / 1_000_000n;
  return `${whole}.${frac.toString().padStart(3, "0")}`;
}
// base units (6 decimals) to "1.20M", "350.12K", "12" (2 decimals, truncated)
export function fmtTokens(units) {
  const tokens = big(units) / 1_000_000n;
  const two = (v, unit) => { const w = v / unit, f = ((v % unit) * 100n) / unit; return `${w}.${f.toString().padStart(2, "0")}`; };
  if (tokens >= 1_000_000_000n) return two(tokens, 1_000_000_000n) + "B";
  if (tokens >= 1_000_000n) return two(tokens, 1_000_000n) + "M";
  if (tokens >= 1_000n) return two(tokens, 1_000n) + "K";
  return tokens.toString();
}
const side = (c) => (c === CALL.BUSIER ? "busier" : "quieter");
// "quieter 58/42": the lean toward the called side first
function leanPair(call, lean) {
  const busier = Math.floor((lean + 50) / 100);
  return call === CALL.BUSIER ? `${busier}/${100 - busier}` : `${100 - busier}/${busier}`;
}
export function bandText(bps) {
  return `${Math.floor(bps / 100)}.${Math.floor((bps % 100) / 10)}`;
}
// The readable line: a pure function of the diary entry and the coin's ticker (State.ticker, which
// initialize sets; "HUNCH" in the vectors), so the site, the bot and the memo agree.
export function diaryLine(e, ticker = "HUNCH") {
  let s = `hour ${e.hour}: `;
  const f = e.flags;
  if (f & DF.BLIND) return s + "blind: the pool layout changed, no calls, no buys.";
  // a one-hour forfeit whose opening tick landed carries the buy clause; its detail may hold the guard's excess
  if (e.outcome === OUTCOME.FORFEIT) s += e.detail > 1 && !(f & DF.GUARD) ? `forfeit x${e.detail}, a tick was missed.` : "forfeit, a tick was missed.";
  else if (f & DF.GRADUATING) s += "graduating, not scored.";
  else if (e.call === CALL.NONE) s += "watching, no call yet.";
  else {
    s += `leaned ${side(e.call)} ${leanPair(e.call, e.lean)}, `;
    if (e.outcome === OUTCOME.HIT || e.outcome === OUTCOME.MISS) {
      const came = e.outcome === OUTCOME.HIT ? e.call : e.call === CALL.BUSIER ? CALL.QUIETER : CALL.BUSIER;
      s += `came ${side(came)}, ${e.outcome === OUTCOME.HIT ? "hit" : "miss"}.`;
    } else if (f & DF.PAUSED) s += "not scored, Meteora paused the pool.";
    else if (f & DF.FEE_CHANGED) {
      // the detail holds the live fee in steps of 5 bps, unless the guard's excess took it
      s += "not scored, Meteora changed the pool fee";
      if (e.detail > 0 && !(f & DF.GUARD)) { const bps = e.detail * 5; s += ` to ${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`; }
      s += ".";
    } else if (f & DF.NO_OUTSIDE) s += "not scored, no outside trades.";
    else if (f & DF.TIE) s += "came level, not scored.";
    else s += "not scored, warm-up.";
  }
  if (e.n > 0) s += ` net ${e.hits}/${e.n}, rule ${e.ruleHits}/${e.n}, flip 50+-${bandText(luckBandBps(e.n))}.`;
  const held = fmtSol3(big(e.held) * 10_000n);
  if (big(e.bought) > 0n) s += ` bought ${fmtSol3(e.bought)} SOL, burned ${fmtTokens(e.burned)} ${ticker}.`;
  else if (e.outcome === OUTCOME.FORFEIT && !(f & BUY_FLAGS)) s += " no buy: the opening tick was missed.";
  else if (f & DF.GRADUATING) s += " no buy: the curve is complete.";
  else if (f & DF.GUARD) s += ` no buy: price ${Math.floor(e.detail / 10)}.${e.detail % 10}% over its hour median, ${held} SOL waits.`;
  else if (f & DF.STALE) s += ` no buy: the tape is stale, ${held} SOL waits.`;
  else if (f & DF.BELOW_MIN) s += ` no buy: below 0.01 SOL, ${held} SOL waits.`;
  else if (f & DF.VOLUME_CAP) s += ` no buy: outside volume cap, ${held} SOL waits.`;
  else if (f & DF.DAY_CAP) s += ` no buy: daily cap, ${held} SOL waits.`;
  else if (f & DF.PAUSED) s += ` no buy: Meteora paused the pool, ${held} SOL waits.`;
  else s += ` no buy: nobody called it, ${held} SOL waits.`;
  s += e.nextCall === CALL.NONE ? " next: no call." : ` next: ${side(e.nextCall)} ${leanPair(e.nextCall, e.nextLean)}.`;
  s += ` brain ${e.brain8}`;
  return s.slice(0, 240);
}
// the diary flags the buy clause sets when the hour's opening tick landed
const BUY_FLAGS = DF.GUARD | DF.STALE | DF.BELOW_MIN | DF.VOLUME_CAP | DF.DAY_CAP | DF.NO_ATTEMPT;
export const CHAPTER_LINES = [
  "",
  "chapter 1: it now reads its own last mistake.",
  "chapter 2: its second layer wakes.",
  "chapter 3: it now learns more slowly.",
];

// ---------- byte images (what the program stores; the replay compares them byte for byte) ----------
export const SIGNAL_LEN = 160;
export const DIARY_ENTRY_LEN = 64;
export const RECORD_LEN = 64;
export const TAPE_ENTRY_LEN = 48;
export const SIGNAL_TAG = [0x48, 0x55, 0x4e, 0x43, 0x48, 0x43, 0x41, 0x4c]; // "HUNCHCAL"

function writer(len) {
  const b = new Uint8Array(len), v = new DataView(b.buffer);
  return {
    b,
    u8: (o, x) => v.setUint8(o, Number(x)),
    u16: (o, x) => v.setUint16(o, Number(x), true),
    u32: (o, x) => v.setUint32(o, Number(x) >>> 0, true),
    i32: (o, x) => v.setInt32(o, Number(x), true),
    u64: (o, x) => v.setBigUint64(o, big(x), true),
    i64: (o, x) => v.setBigInt64(o, big(x), true),
    u128: (o, x) => { v.setBigUint64(o, big(x) & U64_MAX, true); v.setBigUint64(o + 8, big(x) >> 64n, true); },
    bytes: (o, a) => b.set(a, o),
  };
}
export function signalBytes(s) {
  const w = writer(SIGNAL_LEN);
  w.bytes(0, SIGNAL_TAG);
  w.u8(8, 1); w.u8(9, s.phase); w.u8(10, s.call); w.u8(11, s.chapter); w.u16(12, s.lean);
  w.u8(14, s.lastOutcome); w.u8(15, s.flags); w.u32(16, s.hoursSinceLaunch); w.u32(20, s.unixHour);
  w.u64(24, s.madeSlot); w.u32(32, s.n); w.u32(36, s.hits); w.u32(40, s.ruleHits); w.u32(44, s.busierHours);
  w.u32(48, s.quieterCalls); w.u32(52, s.quieterHits); w.u32(56, s.forfeits); w.u16(60, s.luckBand);
  w.u8(62, s.mult); w.bytes(64, s.brain8); w.u64(72, s.budget); w.u64(80, s.plannedSlice);
  w.u64(88, s.spent); w.u64(96, s.burned); w.u32(104, s.buys); w.u32(108, s.skips); w.u16(112, s.poolFeeBps);
  w.u8(114, s.poolStatus); w.u32(116, s.prevN); w.u32(120, s.prevHits); w.u32(124, s.prevRuleHits);
  w.u8(128, s.rule); w.u8(129, s.came); w.u32(132, s.notScored);
  return w.b;
}
export function diaryEntryBytes(e) {
  const w = writer(DIARY_ENTRY_LEN);
  w.u32(0, e.hour); w.u32(4, e.unixHour); w.u64(8, e.slot); w.u8(16, e.call); w.u8(17, e.outcome);
  w.u16(18, e.lean); w.u32(20, e.n); w.u32(24, e.hits); w.u32(28, e.ruleHits); w.u16(32, e.nextLean);
  w.u8(34, e.nextCall); w.u8(35, e.phase); w.u8(36, e.chapter); w.u8(37, e.detail); w.u16(38, e.flags);
  w.u64(40, e.bought); w.u64(48, e.burned); w.bytes(56, e.brain4); w.u32(60, e.held);
  return w.b;
}
export function recordBytes(r) {
  const w = writer(RECORD_LEN);
  w.u16(0, r.day); w.u8(2, r.chapter); w.u8(3, r.phase); w.u32(4, r.hour); w.u64(8, r.slot);
  w.i64(16, r.unixTime); w.u32(24, r.n); w.u32(28, r.hits); w.bytes(32, r.hash);
  return w.b;
}
export function tapeEntryBytes(t) {
  const w = writer(TAPE_ENTRY_LEN);
  w.u32(0, t.bar); w.u8(4, t.sec); w.u8(5, t.utcHour); w.u16(6, t.flags); w.u128(8, t.sqrtPrice);
  w.u64(24, t.cum); w.i32(32, t.ret); w.u16(36, t.feeBps); w.u8(38, t.status); w.u64(40, t.own);
  return w.b;
}

// ---------- the program's state, and its instructions ----------
// cfg: { activationPoint, cliffFeeNumerator, numberOfPeriod, periodFrequency, reductionFactor,
//        migrationQuoteThreshold, migrationSqrtPrice, sqrtStartPrice, curve: [{ sqrtPrice, liquidity }] } (BigInt)
// gapRule: false and maxChapter < 3 only to measure what the rule and the chapters do (K7,
// scripts/k7-crank.mjs); the program always applies the rule and opens every chapter. ticker: what
// initialize stored (the diary line names it).
export function createChain({ seed = SEED, weights = null, gapRule = true, maxChapter = 3, ticker = "HUNCH" } = {}) {
  if (!tickerOk(ticker)) throw new Error("BadTicker");
  const net = new Net(seed);
  if (weights) net.weights = Weights.fromFlat(weights);
  return {
    net, gapRule, maxChapter, ticker,
    phase: PHASE.SETUP, launchTs: 0, launchHour: 0, cfg: null,
    // tick
    ticks: 0, startHour: 0, lastTickBar: 0, lastTickTs: 0, lastSp: 0n, lastFeeTotal: 0n, lastMissedBar: 0,
    cum: 0n, ownFee: 0n, ownRatio: Q32, ownLamports: 0n,
    // scoring
    lastBoundaryHour: 0, lastBoundaryTs: 0, lastBoundaryCum: 0n, refVol: 0n, refSecs: 0n, hourVolPrev: 0n,
    lastOutcome: OUTCOME.NONE, recent: [], chapter: 0, lastRecordDay: -1,
    n: 0, hits: 0, ruleHits: 0, busierHours: 0, quieterCalls: 0, quieterHits: 0, forfeits: 0, notScored: 0,
    // buy
    lastBuyHour: 0, lastBuyTs: 0, buyDay: -1, dayBuys: 0, daySpent: 0n, dayCap: 0n,
    hourStatus: { hour: 0, bought: 0n, burned: 0n, held: 0n, reason: SKIP.NONE, detail: 0 },
    spent: 0n, boughtUnits: 0n, burned: 0n, donated: 0n, buys: 0, skips: 0,
    // the pool phase (adopt_pool): the fee fingerprint and status at the last tick, the liquidity there, what
    // Meteora did in the interval being measured and the one before, the curve's record, the warm-up
    lastFeeFp: 0n, lastStatus: 0, lastLiquidity: 0n, distCur: 0, distPrev: 0, gradLine: false, poolWarmEnd: 0,
    adoptFeeFp: 0n, adoptFeeNum: 0n, adoptTs: 0, adoptHour: 0, prevN: 0, prevHits: 0, prevRuleHits: 0, prevForfeits: 0, prevNotScored: 0,
    // published accounts
    signal: null, signalImage: null, diary: [], records: new Map(), tape: [],
  };
}

export function adopt(S, { now, cfg }) {
  if (S.phase !== PHASE.SETUP) throw new Error("already adopted");
  S.phase = PHASE.CURVE;
  S.cfg = cfg;
  S.launchTs = now;
  S.launchHour = Math.floor(now / HOUR);
  S.signal = emptySignal(S);
  S.signalImage = signalBytes(S.signal);
}

// adopt_pool: the DAMM v2 pool DBC's migration made (the program checks the config, the address, the
// mints, the migrated flag and the position; here the reading, and the position's locked share when
// positionLocked, the position's permanently locked liquidity, is given). reading = { sqrtPrice, lpBFee,
// protocolBFee, liquidity, status, feeBytes, volatilityAccumulator }. The curve's record is kept, the pool's
// starts (a 2-hour warm-up, the running levels reset), and the pool's counters are the next tick's baseline.
export function adoptPool(S, { now, reading: r, positionLocked }) {
  if (S.phase !== PHASE.CURVE && S.phase !== PHASE.GRADUATING) throw new Error("WrongPhase");
  if (positionLocked !== undefined && !positionShareOk(positionLocked, S.cfg.migrationQuoteThreshold, S.cfg.migrationSqrtPrice)) throw new Error("NotOurPosition");
  const fee = dammFeeOf(r.feeBytes, r.volatilityAccumulator ?? 0n);
  const fp = feeFingerprint(r.feeBytes);
  const Hh = Math.floor(now / HOUR);
  Object.assign(S, {
    adoptFeeFp: fp, lastFeeFp: fp, adoptFeeNum: fee.numerator, lastStatus: r.status, lastLiquidity: big(r.liquidity),
    adoptTs: now, adoptHour: Hh, poolWarmEnd: Hh + POOL_WARM_HOURS,
    prevN: S.n, prevHits: S.hits, prevRuleHits: S.ruleHits, prevForfeits: S.forfeits, prevNotScored: S.notScored,
    n: 0, hits: 0, ruleHits: 0, busierHours: 0, quieterCalls: 0, quieterHits: 0, forfeits: 0, notScored: 0,
    lastBoundaryHour: 0, lastBoundaryTs: 0, lastBoundaryCum: S.cum, refVol: 0n, refSecs: 0n, hourVolPrev: 0n,
    lastSp: big(r.sqrtPrice), lastFeeTotal: dammFeeTotal(r), lastTickTs: now, ownFee: 0n, ownRatio: Q32, ownLamports: 0n,
    distCur: 0, distPrev: 0, gradLine: true, phase: PHASE.POOL,
  });
  Object.assign(S.signal, { phase: PHASE.POOL, prevN: S.prevN, prevHits: S.prevHits, prevRuleHits: S.prevRuleHits, poolFeeBps: feeBps(fee.numerator), poolStatus: r.status });
  S.signalImage = signalBytes(S.signal);
}

function emptySignal(S) {
  return {
    phase: S.phase, call: CALL.NONE, chapter: 0, lean: 0, lastOutcome: OUTCOME.NONE, flags: 0, hoursSinceLaunch: 0,
    unixHour: 0, madeSlot: 0n, n: 0, hits: 0, ruleHits: 0, busierHours: 0, quieterCalls: 0, quieterHits: 0,
    forfeits: 0, luckBand: 0, mult: 10, brain8: new Uint8Array(8), budget: 0n, plannedSlice: 0n, spent: 0n, burned: 0n,
    buys: 0, skips: 0, poolFeeBps: 0, poolStatus: 0, prevN: 0, prevHits: 0, prevRuleHits: 0, rule: CALL.NONE, came: CALL.NONE,
    notScored: 0,
  };
}

const x9Of = (S) => (S.lastOutcome === OUTCOME.HIT ? ONE : S.lastOutcome === OUTCOME.MISS || S.lastOutcome === OUTCOME.FORFEIT ? -ONE : 0);
function x10Of(S) {
  const n = S.recent.length;
  if (!n) return 0;
  const hits = S.recent.reduce((a, b) => a + b, 0);
  return Math.floor((hits * ONE) / n) - ONE / 2;
}
function pushRecent(S, hit) { S.recent.push(hit ? 1 : 0); if (S.recent.length > 24) S.recent.shift(); }

export function multiplierOf(call, lean) {
  if (call === CALL.QUIETER && 10000 - lean >= LEAN_STRONG) return 15;
  if (call === CALL.BUSIER && lean >= LEAN_STRONG) return 5;
  return 10;
}
export function plannedSlice(held, mult) {
  held = big(held);
  if (held < MIN_HELD) return 0n;
  let s = (held * big(mult)) / 60n;
  if (s < MIN_HELD) s = MIN_HELD;
  if (s > held) s = held;
  return s;
}

// tick(S, reading) with reading = { now, slot, sqrtPrice, tradingQuoteFee, protocolQuoteFee,
// creatorQuoteFee, quoteReserve, budgetWsol } (BigInt for the pool numbers). Returns what it did, or
// throws an Error whose message is the program's error name.
export function tick(S, r) {
  if (S.phase !== PHASE.CURVE && S.phase !== PHASE.GRADUATING && S.phase !== PHASE.POOL) throw new Error("NotAdopted");
  const now = r.now;
  const sec = now % BAR, bar = Math.floor(now / BAR);
  if (sec >= WINDOW) throw new Error("OutsideWindow");
  if (bar <= S.lastTickBar) throw new Error("AlreadyTicked");
  if (big(now) < S.cfg.activationPoint + big(OPENING_SECONDS)) throw new Error("TooEarly");
  // the DBC pool until adopt_pool; then the DAMM v2 pool (reading: { sqrtPrice, lpBFee, protocolBFee,
  // liquidity, status, feeBytes, volatilityAccumulator, quoteReserve, budgetWsol })
  const onPool = S.phase === PHASE.POOL;
  let feeNum, feeTotal, status = 0, fp = 0n, plain = true, creatorFee = 0n;
  if (onPool) {
    const f = dammFeeOf(r.feeBytes, r.volatilityAccumulator ?? 0n);
    feeNum = f.numerator; plain = f.plain; fp = feeFingerprint(r.feeBytes); status = r.status;
    feeTotal = dammFeeTotal(r);
    // what Meteora did since the last tick marks the boundary interval being measured
    if (fp !== S.lastFeeFp || !plain) S.distCur |= DIST.FEE;
    if (status !== 0 || S.lastStatus !== 0) S.distCur |= DIST.PAUSE;
  } else {
    feeNum = liveFeeNumerator(S.cfg, now);
    feeTotal = sat64(r.tradingQuoteFee + r.protocolQuoteFee);
    creatorFee = big(r.creatorQuoteFee);
  }
  const sp = big(r.sqrtPrice);
  const utcHour = Math.floor((now % DAY) / HOUR);
  const day = Math.floor(now / DAY);
  const dayDue = day > S.lastRecordDay;
  const out = { bar, boundary: false, learned: null, thought: null, entry: null, memo: null, memo2: null, record: null, fills: 0, bar_: null };
  let tflags = 0;

  if (S.ticks === 0) {
    S.startHour = Math.floor(now / HOUR);
    tflags |= TF.BASELINE;
    out.baseline = true;
  } else {
    const elapsed = big(now - S.lastTickTs);
    const missed = bar - S.lastTickBar - 1;
    const feeDelta = feeTotal > S.lastFeeTotal ? feeTotal - S.lastFeeTotal : 0n;
    const outside = feeDelta - minB(S.ownFee, feeDelta);
    const vol = feeNum === 0n ? 0n : sat64((outside * FEE_DENOM) / feeNum);
    const lam = sat64((vol * big(BAR)) / elapsed);
    let ratio = ratioQ32(sp, S.lastSp);
    if (S.ownRatio !== Q32) ratio = (minB(ratio, 1n << 64n) << 32n) / S.ownRatio;
    const retQ = retFromRatio(ratio);
    S.cum = sat64(S.cum + vol);
    // the latest bar nobody ticked (the program also counts its blind ticks as attempts; this engine
    // has no blind mode, so every missed bar here is one)
    if (missed > 0) { tflags |= TF.GAP; S.lastMissedBar = bar - 1; }
    const boundary = bar % H === 0;
    out.boundary = boundary;
    const Hh = Math.floor(now / HOUR);
    let chapterChanged = false;
    if (boundary) {
      const c = Math.min(S.maxChapter, Math.max(S.chapter, chapterOf(Math.max(0, Hh - S.launchHour))));
      if (c !== S.chapter) { S.chapter = c; chapterChanged = true; }
      out.scoring = score(S, now, Hh, feeBps(feeNum));
    }
    const x9 = S.chapter >= 1 ? x9Of(S) : 0, x10 = S.chapter >= 1 ? x10Of(S) : 0;
    const fills = Math.min(missed, MAX_FILL);
    for (let k = 0; k < fills; k++) S.net.feed({ ts: (bar - fills + k) * BAR, retQ: 0, lam: Number(lam), x9: 0, x10: 0 }, true);
    out.fills = fills;
    const barIn = { ts: bar * BAR, retQ, lam: Number(lam), x9, x10 };
    out.bar_ = { ...barIn, fillLam: Number(lam), chapter: S.chapter };
    const step = S.net.step(barIn, S.chapter);
    out.x = step.x; out.learned = step.learned; out.thought = step.thought;
    if (step.learned) tflags |= TF.LEARNED;
    if (step.thought) { tflags |= TF.HAS_CALL; if (step.thought.p >= ONE / 2) tflags |= TF.BUSIER; }
    out.retQ = retQ; out.lam = lam; out.vol = vol;
    if (boundary) {
      tflags |= TF.BOUNDARY;
      boundaryWrite(S, r, now, Hh, step, out, chapterChanged, feeNum, dayDue, { status, creatorFee });
    }
  }

  // the first landed tick of each UTC day: the brain record
  if (dayDue) {
    S.lastRecordDay = day;
    const idx = day - Math.floor(S.launchTs / DAY);
    const hash = sha256(S.net.bytes());
    const rec = {
      day: idx, chapter: S.chapter, phase: S.phase, hour: Math.max(0, Math.floor(now / HOUR) - S.launchHour),
      slot: r.slot, unixTime: now, n: S.n, hits: S.hits, hash,
    };
    S.records.set(idx, recordBytes(rec));
    out.record = { idx, bytes: recordBytes(rec), hash: toHex(hash) };
    tflags |= TF.DAY_RECORD;
  }

  const tapeEntry = {
    bar, sec, utcHour, flags: tflags, sqrtPrice: sp, cum: S.cum, ret: S.ticks === 0 ? 0 : Math.max(-2147483648, Math.min(2147483647, out.retQ)),
    feeBps: feeBps(feeNum), status, own: S.ownLamports,
  };
  S.tape.push({ ...tapeEntry, ts: bar * BAR + sec });
  out.tape = tapeEntryBytes(tapeEntry);
  S.lastTickBar = bar; S.lastTickTs = now; S.lastSp = sp; S.lastFeeTotal = feeTotal;
  S.ownFee = 0n; S.ownRatio = Q32; S.ownLamports = 0n;
  S.ticks++;
  if (onPool) { S.lastFeeFp = fp; S.lastStatus = status; S.lastLiquidity = big(r.liquidity); }
  return out;
}

// Score the hour(s) that ended at this boundary, before the network sees this bar (so inputs 9 and 10
// read the newest outcome).
function score(S, now, Hh, feeBpsNow = 0) {
  const sc = { outcome: OUTCOME.NONE, flags: 0, detail: 0, came: CALL.NONE, endedCall: CALL.NONE, endedLean: 0, k: 0 };
  const sig = S.signal;
  // the pool phase starts its own warm-up at adoption (poolWarmEnd is 0 on the curve)
  const warmEnd = Math.max(S.startHour + WARM_HOURS, S.poolWarmEnd);
  // Meteora changed the fee or paused the pool in the hour measured or in the hour it is measured against
  const disturbed = S.distCur | S.distPrev;
  if (S.lastBoundaryHour === 0) {
    sc.flags |= DF.WARMUP;
  } else {
    const L = S.lastBoundaryHour, k = Hh - L;
    sc.k = k;
    const iv = S.cum - S.lastBoundaryCum, is = big(now - S.lastBoundaryTs);
    if (k === 1 && sig.unixHour === L) { sc.endedCall = sig.call; sc.endedLean = sig.lean; }
    if (S.phase === PHASE.GRADUATING) {
      sc.outcome = OUTCOME.NOT_SCORED; sc.flags |= DF.GRADUATING; S.notScored++;
    } else if (k === 1) {
      if (sig.unixHour === L && sig.call !== CALL.NONE && S.refSecs > 0n && L >= warmEnd) {
        if (disturbed) {
          sc.outcome = OUTCOME.NOT_SCORED; sc.flags |= distFlags(disturbed); S.notScored++;
          if (disturbed & DIST.FEE) sc.detail = Math.min(255, Math.floor(feeBpsNow / 5));
        } else if (iv === 0n && S.refVol === 0n) { sc.outcome = OUTCOME.NOT_SCORED; sc.flags |= DF.NO_OUTSIDE; S.notScored++; }
        else {
          const a = iv * S.refSecs, b = S.refVol * is;
          if (a === b) { sc.outcome = OUTCOME.NOT_SCORED; sc.flags |= DF.TIE; S.notScored++; }
          else {
            const came = a > b ? CALL.BUSIER : CALL.QUIETER;
            const hit = came === sig.call;
            sc.came = came;
            S.n++; if (hit) S.hits++; if (sig.rule === came) S.ruleHits++; if (came === CALL.BUSIER) S.busierHours++;
            if (sig.call === CALL.QUIETER) { S.quieterCalls++; if (hit) S.quieterHits++; }
            sc.outcome = hit ? OUTCOME.HIT : OUTCOME.MISS;
            S.lastOutcome = sc.outcome;
            pushRecent(S, hit);
          }
        }
      } else if (L >= warmEnd) {
        forfeit(S, sc, 1);
      } else sc.flags |= DF.WARMUP;
    } else {
      const count = Math.max(0, Hh - Math.max(L, warmEnd));
      if (count > 0) forfeit(S, sc, count);
      else sc.flags |= DF.WARMUP;
    }
    S.refVol = iv; S.refSecs = is;
    S.hourVolPrev = sat64((iv * 3600n) / is);
  }
  S.lastBoundaryHour = Hh; S.lastBoundaryTs = now; S.lastBoundaryCum = S.cum;
  // the interval just measured becomes the next one's reference
  S.distPrev = S.distCur; S.distCur = 0;
  return sc;
}
const distFlags = (d) => (d & DIST.FEE ? DF.FEE_CHANGED : 0) | (d & DIST.PAUSE ? DF.PAUSED : 0);
function forfeit(S, sc, count) {
  sc.outcome = OUTCOME.FORFEIT; sc.flags |= DF.FORFEIT; sc.detail = Math.min(255, count);
  S.forfeits += count; S.n += count;
  S.lastOutcome = OUTCOME.FORFEIT;
  for (let i = 0; i < Math.min(count, 24); i++) pushRecent(S, false);
}

function boundaryWrite(S, r, now, Hh, step, out, chapterChanged, feeNum, dayDue, { status = 0, creatorFee = 0n } = {}) {
  const sc = out.scoring;
  const th = step.thought;
  let call = CALL.NONE, lean = 0, rule = CALL.NONE;
  // a call needs the whole hour before it: when a tick in the 5 bars before this boundary was missed, no
  // call is made and the hour is forfeited, so skipping ticks to steer the call never helps
  const gap = S.gapRule && S.lastMissedBar > 0 && out.bar - S.lastMissedBar < H;
  if (th && !gap) {
    call = th.p >= ONE / 2 ? CALL.BUSIER : CALL.QUIETER;
    lean = leanBps(th.p);
    rule = th.x[3] < 0 ? CALL.BUSIER : CALL.QUIETER;
  }
  const mult = multiplierOf(call, lean);
  const hash = sha256(S.net.bytes());
  const budget = sat64(big(r.budgetWsol) + big(creatorFee));
  // the buy clause of the hour that ended (H - 1)
  const hs = S.hourStatus;
  let bought = 0n, burned = 0n, held = budget, flags = sc.flags, detail = sc.detail;
  // the buy clause, unless the hour's opening tick was missed (a forfeit of more than one hour)
  if (!(sc.outcome === OUTCOME.FORFEIT && sc.k > 1) && !(flags & DF.GRADUATING)) {
    if (hs.hour === Hh - 1 && hs.reason === SKIP.NONE && hs.bought > 0n) { bought = hs.bought; burned = hs.burned; held = hs.held; }
    else if (hs.hour === Hh - 1 && hs.reason !== SKIP.NONE) {
      held = hs.held;
      flags |= { [SKIP.BELOW_MIN]: DF.BELOW_MIN, [SKIP.GUARD]: DF.GUARD, [SKIP.STALE]: DF.STALE, [SKIP.VOLUME_CAP]: DF.VOLUME_CAP,
        [SKIP.DAY_CAP]: DF.DAY_CAP, [SKIP.IMPACT_CAP]: DF.VOLUME_CAP }[hs.reason];
      if (hs.reason === SKIP.GUARD) detail = Math.min(255, hs.detail);
    } else flags |= DF.NO_ATTEMPT;
  }
  // the graduation line rides on the first boundary after adopt_pool (a chapter change goes first)
  const gradNow = !chapterChanged && S.gradLine;
  if (chapterChanged || gradNow) flags |= DF.CHAPTER;
  if (dayDue) flags |= DF.DAY_RECORD;
  // what Meteora did in the hour that ended (score() just moved it to distPrev)
  flags |= distFlags(S.distPrev);
  const entry = {
    hour: Math.max(0, Hh - 1 - S.launchHour), unixHour: Hh - 1, slot: r.slot, call: sc.endedCall, outcome: sc.outcome,
    lean: sc.endedLean, n: S.n, hits: S.hits, ruleHits: S.ruleHits, nextLean: lean, nextCall: call, phase: S.phase,
    chapter: S.chapter, detail, flags, bought, burned, brain4: hash.slice(0, 4), brain8: toHex(hash.slice(0, 4)),
    held: Number(minB(held / 10_000n, 0xffffffffn)),
  };
  out.entry = entry;
  out.entryBytes = diaryEntryBytes(entry);
  out.memo = diaryLine(entry, S.ticker);
  if (chapterChanged) out.memo2 = CHAPTER_LINES[S.chapter];
  else if (gradNow) { out.memo2 = GRADUATION_LINE; S.gradLine = false; }
  S.diary.push(out.entryBytes);
  // the open call
  const sig = S.signal;
  Object.assign(sig, {
    phase: S.phase, call, chapter: S.chapter, lean, lastOutcome: sc.outcome,
    // FEE_CHANGED / PAUSED: this call's reference hour saw Meteora act, so it will not be scored
    flags: (sc.flags & DF.WARMUP ? SF.WARMUP : 0) | (gap ? SF.GAP : 0) | (S.distPrev & DIST.FEE ? SF.FEE_CHANGED : 0) | (S.distPrev & DIST.PAUSE ? SF.PAUSED : 0),
    hoursSinceLaunch: Math.max(0, Hh - S.launchHour), unixHour: Hh,
    madeSlot: r.slot, n: S.n, hits: S.hits, ruleHits: S.ruleHits, busierHours: S.busierHours, quieterCalls: S.quieterCalls,
    quieterHits: S.quieterHits, forfeits: S.forfeits, luckBand: luckBandBps(S.n), mult, brain8: hash.slice(0, 8),
    budget, plannedSlice: plannedSlice(budget, mult), spent: S.spent, burned: S.burned, buys: S.buys, skips: S.skips,
    poolFeeBps: feeBps(feeNum), poolStatus: status, rule, came: sc.came, notScored: S.notScored,
  });
  S.signalImage = signalBytes(sig);
  // the curve completes: graduating from the next boundary on (no buys, hours not scored)
  if (S.phase === PHASE.CURVE && big(r.quoteReserve) >= S.cfg.migrationQuoteThreshold) S.phase = PHASE.GRADUATING;
}

// ---------- buy_and_burn_curve: the plan (the program then swaps, checks and burns) ----------
// inputs: { now, held (after sync_native and the claim), sqrtPrice, quoteReserve } ; returns
// { error } | { skip: reason, detail } | { slice, minOut, mode, quote, caps }. A wait counts once per hour:
// when S.hourStatus already records a wait in this hour (the caller sets it after a wait, as record_skip
// does: { hour, reason, detail, held }), a plan that would wait again is the error AlreadyWaitedThisHour
// (the program refuses the call and changes nothing); a plan that buys is still allowed.
export function planBuy(S, { now, held, sqrtPrice, quoteReserve }) {
  const Hh = Math.floor(now / HOUR);
  if (S.phase !== PHASE.CURVE) return { error: "NotCurve" };
  if (S.signal.unixHour !== Hh) return { error: "NoBoundaryThisHour" };
  if (S.lastBuyHour === Hh) return { error: "AlreadyBoughtThisHour" };
  if (S.lastBuyTs !== 0 && now - S.lastBuyTs < BUY_GAP) return { error: "TooSoon" };
  if (big(quoteReserve) >= S.cfg.migrationQuoteThreshold) return { error: "CurveComplete" };
  return waitOnce(S, Hh, planCore(S, { now, held, sqrtPrice, quoteReserve }, {
    feeNum: liveFeeNumerator(S.cfg, now),
    impact: (sp) => impactCap(sp, S.cfg),
    quote: (sp, feeNum, slice) => quoteBuy(sp, S.cfg, feeNum, slice),
  }));
}
// ---------- buy_and_burn_pool: the plan on DAMM v2 ----------
// inputs: { now, held (after sync_native and the position's claim), sqrtPrice, quoteReserve (token_b_amount),
// liquidity (live), sqrtMax, status, feeBytes, volatilityAccumulator }. The impact cap uses the smaller of the
// liquidity at the last tick and the live one; the quote uses the live one. A fee above the one at adoption,
// or one Hunch cannot model, is the error FeeRaised (the program's 30; nothing changes).
export function planBuyPool(S, { now, held, sqrtPrice, quoteReserve, liquidity, sqrtMax, status, feeBytes, volatilityAccumulator = 0n }) {
  const Hh = Math.floor(now / HOUR);
  if (S.phase !== PHASE.POOL) return { error: "NotPool" };
  if (S.signal.unixHour !== Hh) return { error: "NoBoundaryThisHour" };
  if (S.lastBuyHour === Hh) return { error: "AlreadyBoughtThisHour" };
  if (S.lastBuyTs !== 0 && now - S.lastBuyTs < BUY_GAP) return { error: "TooSoon" };
  if (status !== 0) return { error: "PoolPaused" };
  const fee = dammFeeOf(feeBytes, volatilityAccumulator);
  if (poolFeeRefused(fee, S.adoptFeeNum)) return { error: "FeeRaised" };
  const lLive = big(liquidity), lCap = minB(S.lastLiquidity, lLive);
  return waitOnce(S, Hh, planCore(S, { now, held, sqrtPrice, quoteReserve }, {
    feeNum: fee.numerator,
    impact: (sp) => poolImpactCap(sp, lCap, sqrtMax),
    quote: (sp, feeNum, slice) => quotePoolBuy(sp, lLive, sqrtMax, feeNum, slice),
    lCap,
  }));
}
// The hour's first wait is the one recorded: a second plan that would wait in the same hour is refused
// (record_skip in processor.rs: ALREADY_WAITED_THIS_HOUR, error 28).
function waitOnce(S, Hh, plan) {
  const hs = S.hourStatus;
  return plan.skip !== undefined && hs.hour === Hh && hs.reason !== SKIP.NONE ? { error: "AlreadyWaitedThisHour" } : plan;
}
// The slice, the floor, the guard and the three caps, shared by both buys (plan_buy in processor.rs).
function planCore(S, { now, held, sqrtPrice, quoteReserve }, market) {
  const day = Math.floor(now / DAY);
  const dayReset = day !== S.buyDay;
  const dayCap = dayReset ? maxB((big(quoteReserve) * DAY_CAP_BPS) / 10000n, DAY_CAP_FLOOR) : S.dayCap;
  const daySpent = dayReset ? 0n : S.daySpent, dayBuys = dayReset ? 0 : S.dayBuys;
  const base = { day, dayCap, daySpent, dayBuys, dayReset };
  if (dayBuys >= DAY_MAX_BUYS) return { ...base, skip: SKIP.DAY_CAP };
  held = big(held);
  if (held < MIN_HELD) return { ...base, skip: SKIP.BELOW_MIN };
  let slice = plannedSlice(held, S.signal.mult);
  // guard: the last 6 tape samples
  const samples = S.tape.slice(-GUARD_SAMPLES);
  if (!samples.length || now - samples[samples.length - 1].ts > GUARD_STALE) return { ...base, skip: SKIP.STALE };
  const med = medianSqrt(samples.map((s) => s.sqrtPrice));
  const excess = guardExcess(big(sqrtPrice), med);
  if (excess !== null) return { ...base, skip: SKIP.GUARD, detail: excess };
  const feeNum = market.feeNum;
  const impact = market.impact(big(sqrtPrice));
  const volCap = S.hourVolPrev / VOLUME_CAP_DIV;
  const dayLeft = dayCap > daySpent ? dayCap - daySpent : 0n;
  let cap = impact, binding = SKIP.IMPACT_CAP;
  if (volCap < cap) { cap = volCap; binding = SKIP.VOLUME_CAP; }
  if (dayLeft < cap) { cap = dayLeft; binding = SKIP.DAY_CAP; }
  const caps = { impact, volCap, dayLeft, want: slice };
  if (slice > cap) { slice = cap; caps.binding = binding; }
  if (slice < MIN_HELD) return { ...base, skip: caps.binding ?? binding, caps };
  const q = market.quote(big(sqrtPrice), feeNum, slice);
  return { ...base, slice, minOut: (q.out * MIN_OUT_BPS) / 10000n, mode: q.partial ? 1 : 0, quote: q, caps, feeNum, lCap: market.lCap };
}
// The guard: spot against the median as a Q16.16 price ratio; the excess in tenths of a percent (at most
// 255) when it is more than 5% over, else null.
export function guardExcess(spot, med) {
  const rq = ratioQ32(spot, med);
  const sq = Number((minB(rq, 3n * Q32) ** 2n) >> 48n);
  if (sq * 10000 > ONE * (10000 + GUARD_BPS)) return Math.min(255, Math.floor(((sq - ONE) * 1000) / ONE));
  return null;
}
export function medianSqrt(list) {
  const s = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2n;
}

export { N_WEIGHTS_V1, u64dec };
