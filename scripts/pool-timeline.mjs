// Turns 10-minute bars (close in SOL per token, volume in SOL) into what Hunch's tick would read from a
// Meteora DBC pool: sqrt_price (Q64.64, u128) and the cumulative quote fee counters, at a tick time
// inside each bar's 30-second window. Deterministic, integers only (BigInt).
//
// The tick of bar b reads everything before bar b's start: sqrt_price at the close of bar b-1, and the
// counters summed over bars 0..b-1. Fees follow the coin's numbers after the 5-second opening: 3.75% of
// each trade, 20% of it to the protocol counter, the rest to the trading counter, 33% of that to the
// creator (the budget). A cranker schedule decides the second of each tick and which ticks are missed.

export const FEE_NUM = 37_500_000n;          // 3.75% of 1e9
export const PROTOCOL_PCT = 20n;
export const CREATOR_PCT = 33n;

export function isqrtBig(v) {
  if (v < 2n) return v;
  let x = 1n << BigInt(Math.ceil(v.toString(2).length / 2));
  for (;;) { const y = (x + v / x) >> 1n; if (y >= x) return x; x = y; }
}

// close (SOL per token, 6 significant figures) -> sqrt(lamports per base unit) in Q64.64
export function sqrtPriceOf(close) {
  const c = BigInt(Math.round(close * 1e15)); // close x 1e15, lamports per base unit = c / 1e12
  return isqrtBig((c << 128n) / 1_000_000_000_000n);
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
}

// bars: { t0, close[], vol[] }. Options: secondsMax (ticks land at second 0..secondsMax-1 of a bar),
// missed (Set of bar indexes whose tick is not sent), seed (the schedule's randomness).
// Returns { adoptTs, activation, ticks: [{ b, now, slot, missed, sqrtPrice, tradingQuoteFee,
// protocolQuoteFee, creatorQuoteFee, quoteReserve, budgetWsol }] }
export function poolTimeline({ t0, close, vol }, { secondsMax = 30, missed = new Set(), seed = 1, quoteReserve = 10_000_000_000n } = {}) {
  if (t0 % 600 !== 0) throw new Error("t0 must start a bar");
  const rnd = lcg(seed);
  const activation = t0 - 400, adoptTs = t0 - 300;
  let trading = 0n, protocol = 0n, creator = 0n;
  const ticks = [];
  for (let b = 0; b < close.length; b++) {
    const sec = secondsMax > 1 ? rnd() % secondsMax : 0;
    const now = t0 + b * 600 + sec;
    const sp = sqrtPriceOf(close[Math.max(b - 1, 0)]);
    ticks.push({
      b, now, slot: BigInt(1_000_000 + b * 1500 + sec), missed: missed.has(b), sqrtPrice: sp,
      tradingQuoteFee: trading, protocolQuoteFee: protocol, creatorQuoteFee: creator, quoteReserve, budgetWsol: 0n,
    });
    // bar b's trades, read by the next tick
    const lam = BigInt(Math.round(vol[b] * 1e9));
    const fee = (lam * FEE_NUM + 999_999_999n) / 1_000_000_000n;
    const prot = (fee * PROTOCOL_PCT) / 100n;
    trading += fee - prot;
    protocol += prot;
    creator += ((fee - prot) * CREATOR_PCT) / 100n;
  }
  return { adoptTs, activation, ticks };
}

// The missed-tick schedule used by the tests: about 0.5% of ticks at random, one missed boundary on
// day 3, and a 15-bar outage on day 10 (longer than the 12 bars the tape fills).
export function standardMisses(n, seed = 7) {
  const rnd = lcg(seed);
  const m = new Set();
  for (let b = 1; b < n; b++) if (rnd() % 200 === 0) m.add(b);
  if (n > 3 * 144 + 12) m.add(3 * 144 + 6 * 2);
  if (n > 10 * 144 + 20) for (let b = 10 * 144 + 3; b < 10 * 144 + 18; b++) m.add(b);
  m.delete(0);
  return m;
}

// The DBC config numbers the chain engine needs (the user's 5-second opening schedule).
export function testConfig(activation) {
  return {
    activationPoint: BigInt(activation),
    cliffFeeNumerator: 500_000_000n, numberOfPeriod: 5n, periodFrequency: 1n, reductionFactor: 92_500_000n,
    migrationQuoteThreshold: 85_000_000_000n, migrationSqrtPrice: 0n, sqrtStartPrice: 0n, curve: [],
  };
}
