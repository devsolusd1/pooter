// Two pool-phase rules from site/core/chain.js, case by case, for the Rust host test
// adoption_bar_and_pool_fee_refusal_equal_chain_js (programs/hunch/tests/host.rs):
//
//  - adopt_pool's bar: the liquidity DBC's migration builds from the pinned threshold and migration sqrt
//    price (migrationLiquidity), and whether a position's permanently locked liquidity passes 25% of it
//    (positionShareOk);
//  - buy_and_burn_pool's refusal of a fee above the one at adoption, or one Hunch cannot model
//    (poolFeeRefused, the program's error 30).
//
// It also checks, in JavaScript, that adoptPool refuses a dust position and planBuyPool a raised fee.
// Writes programs/tests/vectors/pool-rules.txt. Usage: node hunch/programs/tests/export-pool-rules.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createChain, adopt, adoptPool, planBuyPool, dammFeeBytes, dammFeeOf, migrationLiquidity, positionShareOk, poolFeeRefused,
  DAMM_MIN_SQRT_PRICE, HOUR, PHASE,
} from "../../site/core/chain.js";
import { toHex } from "../../site/core/sha256.js";

const here = dirname(fileURLToPath(import.meta.url));
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
let seed = 0x9001;
const r32 = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const rb = (bits) => { let v = 0n; for (let k = 0; k < bits; k += 32) v = (v << 32n) | BigInt(r32()); return v & ((1n << BigInt(bits)) - 1n); };

const lines = ["# pool-phase rules from site/core/chain.js: mliq <quote> <sqrt_price> <L or ->; share <locked> <quote> <sqrt_price> <0|1>;",
  "# pfee <fee bytes hex> <volatility_accumulator> <adopt_fee_num> <refused 0|1>"];

// ---- the migration's liquidity and the 25% bar ----
const sqrts = () => {
  switch (r32() % 5) {
    case 0: return DAMM_MIN_SQRT_PRICE - BigInt(r32() % 3); // at or below the minimum: no bar can pass
    case 1: return DAMM_MIN_SQRT_PRICE + 1n + rb(r32() % 40); // just above it: L overflows 128 bits for most quotes
    default: return (1n << BigInt(40 + (r32() % 80))) + rb(40);
  }
};
for (let i = 0; i < 300; i++) {
  const quote = r32() % 7 === 0 ? (1n << 64n) - 1n : rb(20 + (r32() % 44));
  const sp = sqrts();
  const l = migrationLiquidity(quote, sp);
  lines.push(`mliq ${quote} ${sp} ${l === null ? "-" : l}`);
  // positions around the bar: the exact quarter and one under it, the creator's 33%, dust, nothing, huge
  const q = l === null ? 0n : (l * 25n + 99n) / 100n;
  for (const locked of [q, q > 0n ? q - 1n : 0n, l === null ? 1n : (l * 33n) / 100n, 1n + rb(20), 0n, (1n << 128n) - 1n]) {
    lines.push(`share ${locked} ${quote} ${sp} ${positionShareOk(locked, quote, sp) ? 1 : 0}`);
  }
}

// ---- the pool buy's fee refusal ----
for (let i = 0; i < 200; i++) {
  const dyn = r32() % 6 === 0;
  const fb = dammFeeBytes({
    cliff: [37_500_000n, 37_500_001n, 10_000_000n, 37_500_000n, 100_000_000n, 500_000_000n][r32() % 6], mode: [0, 0, 0, 0, 1, 3][r32() % 6],
    nPeriods: r32() % 6 === 0 ? r32() % 10 : 0, frequency: BigInt(r32() % 3), reduction: BigInt(r32() % 3) * 1_000_000n,
    dynamic: dyn, maxVolatilityAccumulator: r32() % 300_000, variableFeeControl: r32() % 200_000, binStep: 1 + (r32() % 100),
    filterPeriod: 10, decayPeriod: 120, reductionFactor: 5000, feeVersion: r32() % 2,
  });
  const volAcc = dyn && r32() % 2 ? BigInt(r32() % 300_000) : 0n;
  const adoptFeeNum = [37_500_000n, 37_500_000n, 10_000_000n, 100_000_000n][r32() % 4];
  lines.push(`pfee ${toHex(fb)} ${volAcc} ${adoptFeeNum} ${poolFeeRefused(dammFeeOf(fb, volAcc), adoptFeeNum) ? 1 : 0}`);
}
writeFileSync(resolve(here, "vectors/pool-rules.txt"), lines.join("\n") + "\n");

// ---- the same rules where chain.js applies them ----
{
  const sp = 275_000_000_000_000_000n, threshold = 96_101_000_000n;
  const cfg = {
    activationPoint: 1_790_000_000n, cliffFeeNumerator: 500_000_000n, numberOfPeriod: 5n, periodFrequency: 1n, reductionFactor: 92_500_000n,
    migrationQuoteThreshold: threshold, migrationSqrtPrice: sp, sqrtStartPrice: sp / 4n, curve: [{ sqrtPrice: sp, liquidity: 1n << 100n }],
  };
  const reading = { sqrtPrice: sp, lpBFee: 0n, protocolBFee: 0n, liquidity: 1n << 100n, status: 0, feeBytes: dammFeeBytes({ cliff: 37_500_000n }), volatilityAccumulator: 0n };
  const L = migrationLiquidity(threshold, sp);
  const fresh = () => { const S = createChain(); adopt(S, { now: 1_790_000_100, cfg }); return S; };
  // adoptPool: a dust position (1% of the migration's liquidity) is refused; the creator's 33% is adopted,
  // whatever an outsider locked in the pool besides (the bar does not read the pool's lock)
  let threw = null;
  try { adoptPool(fresh(), { now: 1_790_100_000, reading, positionLocked: L / 100n }); } catch (e) { threw = e.message; }
  must(threw === "NotOurPosition", `adoptPool took a dust position (${threw})`);
  const S = fresh();
  adoptPool(S, { now: 1_790_100_000, reading, positionLocked: (L * 33n) / 100n });
  must(S.phase === PHASE.POOL && S.adoptFeeNum === 37_500_000n, "adoptPool refused the creator's position");
  // planBuyPool: a raised fee, a dynamic fee and a running schedule are FeeRaised; the adopted fee and a cut are not
  const now = 1_790_103_600 + 60;
  S.signal.unixHour = Math.floor(now / HOUR);
  const plan = (feeBytes, volatilityAccumulator = 0n) => planBuyPool(S, { now, held: 1_000_000_000n, sqrtPrice: sp, quoteReserve: threshold, liquidity: 1n << 100n, sqrtMax: 1n << 127n, status: 0, feeBytes, volatilityAccumulator });
  for (const [what, fb] of [
    ["50%", dammFeeBytes({ cliff: 500_000_000n })],
    ["a dynamic fee", dammFeeBytes({ cliff: 37_500_000n, dynamic: true, maxVolatilityAccumulator: 350_000, variableFeeControl: 20_000, binStep: 10 })],
    ["a running schedule", dammFeeBytes({ cliff: 37_500_000n, nPeriods: 5, frequency: 1n, reduction: 1_000_000n })],
  ]) must(plan(fb).error === "FeeRaised", `planBuyPool bought at ${what}`);
  for (const [what, fb] of [["3.75%", dammFeeBytes({ cliff: 37_500_000n })], ["1%", dammFeeBytes({ cliff: 10_000_000n })]]) {
    must(plan(fb).error === undefined, `planBuyPool refused ${what}: ${plan(fb).error}`);
  }
  must(plan(dammFeeBytes({ cliff: 500_000_000n }), 0n).error === "FeeRaised" && poolFeeRefused(dammFeeOf(dammFeeBytes({ cliff: 37_500_001n })), 37_500_000n), "one unit above is refused");
}
console.log(`pool-rules.txt: ${lines.length - 2} cases (migration liquidity, the adoption bar, the pool fee refusal); adoptPool and planBuyPool checked`);
