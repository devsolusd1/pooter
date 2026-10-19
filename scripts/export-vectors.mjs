// Kill test K2, the JavaScript side. Writes what the reference engine saw and did, so the Rust ports can
// be checked against it bar by bar:
//
//  programs/hunch-net/tests/vectors/v0/*.txt  the chapter-0 view (createModel, the 8-8-1 network the site
//      replays) on the rehearsal replay and the 7 simulated coins. These files are the stage-1 vectors:
//      the chapter-0 network must still produce them byte for byte.
//  programs/hunch-net/tests/vectors/v1/*.txt  version one (10-8-8-1 with chapters) driven by the chain
//      engine (site/core/chain.js) from synthetic pool readings of the same coins, with a cranker that
//      ticks at a random second inside the window and misses some ticks: the integer bar each landed tick
//      fed (with the missed bars it filled), the training step, the forward pass and the weights hash.
//  programs/tests/vectors/chain-replay.txt    the chain engine's ticks over the rehearsal replay: what
//      the pool account held at each tick, and what the program must write (open call, diary entry and
//      memo, brain record, weights hash). The LiteSVM replay drives the real program with it.
//  programs/tests/vectors/chain-replay-<strategy>.txt   the same for adversarial crankers (K7, see
//      crank-strategies.mjs): the pool read per second from the 5-minute candles, the ticks at the
//      seconds and with the skips the strategy chose. The LiteSVM replay checks the program on them too.
//
// Usage: node hunch/scripts/export-vectors.mjs

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createModel, hashWeights, ONE, SEED, LR_SHIFT, N_WEIGHTS, N_WEIGHTS_V1, Weights, Net } from "../site/core/net.js";
import { createReplay } from "../site/core/replay.js";
import { createChain, adopt, tick, ratioQ32, retFromRatio, luckBandBps, impactCap, quoteBuy, guardExcess, plannedSlice, multiplierOf, liveFeeNumerator, medianSqrt, diaryLine, diaryEntryBytes, OUTCOME, DF, PHASE, adoptPool, dammFeeBytes, dammFeeOf, feeFingerprint, poolImpactCap, quotePoolBuy, signalBytes } from "../site/core/chain.js";
import { toHex } from "../site/core/sha256.js";
import { mergeBars } from "./build-replay.mjs";
import { poolTimeline, standardMisses, testConfig, sqrtPriceOf } from "./pool-timeline.mjs";
import { readingModel, runCrank } from "./crank-strategies.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const vecDir = resolve(here, "../programs/hunch-net/tests/vectors");
const v0Dir = resolve(vecDir, "v0"), v1Dir = resolve(vecDir, "v1");
const chainDir = resolve(here, "../programs/tests/vectors");
for (const d of [v0Dir, v1Dir, chainDir]) mkdirSync(d, { recursive: true });

const isInt = (v) => Number.isSafeInteger(v);
function must(cond, msg) { if (!cond) throw new Error(msg); }
const clip = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ints = (a) => { for (const v of a) must(isInt(v), `not a safe integer: ${v}`); return a.map((v) => (Object.is(v, -0) ? 0 : v)).join(" "); };
const hex = (b) => Buffer.from(b).toString("hex");

// ---------- v0: the chapter-0 view, exactly the stage-1 format ----------
const HEADER_V0 = [
  "# hunch-net test vectors, written by hunch/scripts/export-vectors.mjs from hunch/site/core/net.js",
  "# coin <name> bars <n> t0 <unix> step <s> seed <seed> lr <shift>",
  "# init <81 Q16.16 weights in LAYOUT order: W1 j*8+i, b1, W2, b2>",
  "# b <t> <ts> <r_raw> <lam> | <xk> <x0..x7> | <lk> <sample> <y> <p_train> <e_train> <version> | <tk> <z1_0..z1_7> <z2> <p> <call> | <sha256 of weights after the bar>",
  "#   r_raw = round(65536 * (close / prev_close - 1)) before clipping (0 on bar 0); lam = round(vol * 1e9)",
  "#   xk/lk/tk = 1 when the bar has inputs / a training step / a forward pass (fields are 0 otherwise)",
  "#   y: 1 busier, 0 quieter; call: 1 busy, 0 quiet",
  "# final <81 weights>",
  "# finalhash <hex>",
];

function exportV0(name, t0, step, close, vol) {
  const n = close.length;
  const m = createModel();
  const lines = [...HEADER_V0, `coin ${name} bars ${n} t0 ${t0} step ${step} seed ${SEED} lr ${LR_SHIFT}`, `init ${ints(m.weightsQ())}`];
  let learns = 0, thinks = 0, prev = null;
  for (let t = 0; t < n; t++) {
    const ts = t0 + t * step;
    const rRaw = t > 0 ? Math.round((close[t] / prev - 1) * ONE) : 0;
    prev = close[t];
    const { fed, learned, thought } = m.step({ ts, close: close[t], vol: vol[t] });
    const r = m.net.rHist[m.net.rHist.length - 1], lam = m.net.lamHist[m.net.lamHist.length - 1];
    must(isInt(rRaw) && clip(rRaw, -ONE, 4 * ONE) === r, `${name} bar ${t}: return ${rRaw} does not clip to net.js's ${r}`);
    must(isInt(lam) && lam >= 0, `${name} bar ${t}: lamports ${lam}`);
    must(Math.round(fed.move * ONE) === r, `${name} bar ${t}: move`);
    const xs = fed.x ? `1 ${ints(fed.x)}` : `0 ${ints(new Array(8).fill(0))}`;
    let ls = "0 0 0 0 0";
    if (learned) {
      learns++;
      const yb = learned.y === "busy" ? 1 : 0;
      ls = `1 ${learned.sample} ${yb} ${ints([learned.p * ONE, learned.error * ONE])}`;
    }
    let ts_ = `0 ${ints(new Array(8).fill(0))} 0 0 0`;
    if (thought) {
      thinks++;
      ts_ = `1 ${ints(thought.z1.map((v) => v * ONE))} ${ints([thought.z2 * ONE, thought.pQ])} ${thought.call === "busy" ? 1 : 0}`;
    }
    lines.push(`b ${t} ${ts} ${rRaw} ${lam} ${xs} ${ls} ${m.version} ${ts_} ${hashWeights(m.weightsQ())}`);
  }
  const fin = m.weightsQ();
  must(fin.length === N_WEIGHTS, "weight count");
  lines.push(`final ${ints(fin)}`, `finalhash ${m.brainHash()}`);
  writeFileSync(resolve(v0Dir, `${name}.txt`), lines.join("\n") + "\n");
  return { name, bars: n, learns, thinks, hash: m.brainHash() };
}

// ---------- v1: version one through the chain engine ----------
const HEADER_V1 = [
  "# hunch-net version-one vectors, written by hunch/scripts/export-vectors.mjs (site/core/net.js driven by site/core/chain.js)",
  "# coin <name> landed <ticks> launchhour <h> seed <seed>",
  "# init <169 Q16.16 weights in canonical order: W1 j*10+i, b1, W2 k*8+j, b2, W3, b3>",
  "# b <t> <ts> <fills> <fill_lam> <ret_q> <lam> <x9> <x10> <chapter> <xk> <x0..x9> <lk> <sample> <y> <p_train> <e_train> <version>",
  "#   <tk> <z1_0..7> <z2_0..7> <z3> <p> <call> <sha256 of the 676 weight bytes after the bar>",
  "#   fills = missed bars fed before this one (ts - (fills - k) * 600, volume fill_lam, no move, no inputs)",
  "#   ret_q = the outside price return in Q16.16 before clipping; lam = outside lamports per 600 s",
  "# final <169 weights>",
  "# finalhash <hex>",
];

function runChain(name, bars, { seed = 1 } = {}) {
  const missed = standardMisses(bars.close.length, seed + 6);
  const tl = poolTimeline(bars, { missed, seed });
  const S = createChain();
  adopt(S, { now: tl.adoptTs, cfg: testConfig(tl.activation) });
  return { S, tl };
}

function exportV1(name, bars, seed) {
  const { S, tl } = runChain(name, bars, { seed });
  const lines = [...HEADER_V1, `coin ${name} landed ${tl.ticks.filter((t) => !t.missed).length} launchhour ${S.launchHour} seed ${SEED}`,
    `init ${ints(S.net.weights.flat())}`];
  let learns = 0, thinks = 0, fills = 0;
  for (const r of tl.ticks) {
    if (r.missed) continue;
    const o = tick(S, r);
    if (o.baseline) continue;
    const b = o.bar_;
    const xs = o.x ? `1 ${ints(o.x)}` : `0 ${ints(new Array(10).fill(0))}`;
    let ls = "0 0 0 0 0";
    if (o.learned) { learns++; ls = `1 ${o.learned.sample} ${o.learned.y} ${ints([o.learned.f.p, o.learned.e])}`; }
    let th = `0 ${ints(new Array(16).fill(0))} 0 0 0`;
    if (o.thought) { thinks++; th = `1 ${ints(o.thought.z1)} ${ints(o.thought.z2)} ${ints([o.thought.z3, o.thought.p])} ${o.thought.p >= ONE / 2 ? 1 : 0}`; }
    fills += o.fills;
    lines.push(`b ${S.net.t} ${b.ts} ${o.fills} ${b.fillLam} ${b.retQ} ${b.lam} ${b.x9} ${b.x10} ${b.chapter} ${xs} ${ls} ${S.net.version} ${th} ${S.net.brainHash()}`);
  }
  const fin = S.net.weights.flat();
  must(fin.length === N_WEIGHTS_V1, "weight count v1");
  lines.push(`final ${ints(fin)}`, `finalhash ${S.net.brainHash()}`);
  writeFileSync(resolve(v1Dir, `${name}.txt`), lines.join("\n") + "\n");
  return { name, learns, thinks, fills, n: S.n, hits: S.hits, rule: S.ruleHits, forfeits: S.forfeits, chapter: S.chapter, hash: S.net.brainHash() };
}

// ---------- the chain replay for the program (LiteSVM) ----------
function exportChainReplay(name, bars, seed) {
  const { S, tl } = runChain(name, bars, { seed });
  return writeChainReplay(`chain-${name}.txt`, name, bars.t0, tl, S);
}
// A cranker strategy's schedule over a coin's 5-minute candles (K7), replayed through a fresh chain.
function exportCrankReplay(coin, strategy) {
  const rows = JSON.parse(readFileSync(resolve(here, `../sim/data/ohlcv_${coin}.json`), "utf8")).rows;
  const model = readingModel(rows);
  const { schedule } = runCrank(model, strategy, { seed: 11 });
  const tl = { adoptTs: model.t0 - 300, activation: model.t0 - 400, ticks: schedule };
  const S = createChain();
  adopt(S, { now: tl.adoptTs, cfg: testConfig(tl.activation) });
  return writeChainReplay(`chain-replay-${strategy}.txt`, `${coin}:${strategy}`, model.t0, tl, S);
}
function writeChainReplay(file, name, t0, tl, S) {
  const lines = [
    "# chain replay: written by hunch/scripts/export-vectors.mjs from site/core/chain.js; tab-separated",
    "# coin <name> t0 <t0> adopt <unix> activation <unix> seed <seed> launchhour <h>",
    "# tick <i> <now> <slot> <sqrt_price> <trading_quote_fee> <protocol_quote_fee> <creator_quote_fee> <quote_reserve> <budget_wsol>",
    "#      <weights sha256 after> <p or -1> <boundary 0|1> <open call hex or -> <diary entry hex or -> <memo or -> <chapter memo or -> <record day or -1> <record hex or -> <tape entry hex>",
    "# miss <i> <now>   a tick the cranker missed (not sent)",
    "# end <weights sha256> <n> <hits> <rule_hits> <forfeits> <not_scored>",
    `coin\t${name}\tt0\t${t0}\tadopt\t${tl.adoptTs}\tactivation\t${tl.activation}\tseed\t${SEED}\tlaunchhour\t${S.launchHour}`,
  ];
  let boundaries = 0;
  for (const r of tl.ticks) {
    if (r.missed) { lines.push(`miss\t${r.b}\t${r.now}`); continue; }
    const o = tick(S, r);
    if (o.boundary) boundaries++;
    lines.push([
      "tick", r.b, r.now, r.slot, r.sqrtPrice, r.tradingQuoteFee, r.protocolQuoteFee, r.creatorQuoteFee, r.quoteReserve, r.budgetWsol,
      S.net.brainHash(), o.thought ? o.thought.p : -1, o.boundary ? 1 : 0,
      o.boundary ? hex(S.signalImage) : "-", o.entryBytes ? hex(o.entryBytes) : "-", o.memo ?? "-", o.memo2 ?? "-",
      o.record ? o.record.idx : -1, o.record ? hex(o.record.bytes) : "-", hex(o.tape),
    ].join("\t"));
  }
  lines.push(`end\t${S.net.brainHash()}\t${S.n}\t${S.hits}\t${S.ruleHits}\t${S.forfeits}\t${S.notScored}`);
  writeFileSync(resolve(chainDir, file), lines.join("\n") + "\n");
  return { name, boundaries, n: S.n, hits: S.hits, ruleHits: S.ruleHits, forfeits: S.forfeits, notScored: S.notScored, quieterCalls: S.quieterCalls, quieterHits: S.quieterHits, busierHours: S.busierHours, S };
}

// ---------- the pool phase for the program (LiteSVM): graduation, adopt_pool, ticks on DAMM v2 ----------
// The rehearsal replay on the curve until a boundary on day 6, where the curve completes (the DBC pool's
// quote reserve passes the threshold: graduating, no trading on DBC); DBC migrates and adopt_pool lands
// 1.5 hours later; then 7 days on a DAMM v2 pool fed by the same bars (fees 3.75%, 20% to the protocol
// counter), with what Meteora can do: the fee changed to 1.00% for 5 hours, a dynamic fee switched on for
// 5 hours (a fee Hunch does not model), the pool paused for 2 hours (no trades), liquidity added for 50
// minutes (it must not matter to the record), and missed ticks (forfeits) in the pool phase too.
const MAX_SQRT_PRICE = 79226673521066979257578248091n;
function exportPoolReplay(bars, seed) {
  const n = bars.close.length;
  const missedCurve = standardMisses(n, seed + 6);
  const tl = poolTimeline(bars, { missed: missedCurve, seed });
  const S = createChain();
  adopt(S, { now: tl.adoptTs, cfg: testConfig(tl.activation) });
  const off = (bars.t0 / 600) % 6;
  let G = 6 * 144;
  while ((G + off) % 6 !== 0) G++;
  const A = G + 9, E = Math.min(n - 1, A + 7 * 144);
  const L0 = 3n * 10n ** 18n; // the pool's liquidity (a few hundred SOL deep at these prices)
  const feeAt = (b) => {
    const k = b - A;
    if (k >= 60 && k < 90) return dammFeeBytes({ cliff: 10_000_000n });
    if (k >= 200 && k < 230) return dammFeeBytes({ cliff: 37_500_000n, dynamic: true, maxVolatilityAccumulator: 350_000, variableFeeControl: 20_000, binStep: 10, filterPeriod: 10, decayPeriod: 120, reductionFactor: 5_000 });
    return dammFeeBytes({ cliff: 37_500_000n });
  };
  const pausedAt = (b) => b - A >= 400 && b - A < 412;
  const liqAt = (b) => (b - A >= 500 && b - A < 505 ? 5n * L0 : L0);
  const volAccAt = (b) => (b - A >= 200 && b - A < 230 ? 50_000n + BigInt((b - A) * 1_000) : 0n);
  // pool-phase misses: about 1% of ticks, one boundary on pool day 2
  const rnd = (() => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; }; })();
  const missedPool = new Set();
  for (let b = A + 1; b <= E; b++) if (rnd() % 100 === 0) missedPool.add(b);
  let mb = A + 2 * 144; while ((mb + off) % 6 !== 0) mb++;
  missedPool.add(mb);
  const lines = [
    "# pool replay: written by hunch/scripts/export-vectors.mjs from site/core/chain.js; tab-separated",
    "# coin, tick, miss and end lines as in chain-replay.txt (the DBC part; quote_reserve passes the threshold at the graduation boundary)",
    "# adopt <now> <slot> <sqrt_price> <total_lp_b_fee> <total_protocol_b_fee> <liquidity> <status> <fee bytes hex (pool[8..80] ++ pool[484..487])>",
    "#       <volatility_accumulator> <token_b_amount> <sqrt_max_price> <open call hex after> <fee fingerprint u64>",
    "# ptick <i> <now> <slot> <sqrt_price> <total_lp_b_fee> <total_protocol_b_fee> <liquidity> <status> <fee bytes hex> <volatility_accumulator>",
    "#       <token_b_amount> <budget_wsol> <weights sha256 after> <p or -1> <boundary 0|1> <open call hex or -> <diary entry hex or -> <memo or -> <chapter memo or ->",
    "#       <record day or -1> <record hex or -> <tape entry hex>",
    `coin\tpool:replay\tt0\t${bars.t0}\tadopt\t${tl.adoptTs}\tactivation\t${tl.activation}\tseed\t${SEED}\tlaunchhour\t${S.launchHour}`,
  ];
  const emit = (kind, b, r, o, extra) => lines.push([
    kind, b, r.now, r.slot, ...extra,
    S.net.brainHash(), o.thought ? o.thought.p : -1, o.boundary ? 1 : 0,
    o.boundary ? hex(S.signalImage) : "-", o.entryBytes ? hex(o.entryBytes) : "-", o.memo ?? "-", o.memo2 ?? "-",
    o.record ? o.record.idx : -1, o.record ? hex(o.record.bytes) : "-", hex(o.tape),
  ].join("\t"));
  // the DBC part
  const frozen = tl.ticks[G];
  for (let b = 0; b <= A; b++) {
    const t = tl.ticks[b];
    const r = b < G ? t : { ...t, sqrtPrice: frozen.sqrtPrice, tradingQuoteFee: frozen.tradingQuoteFee, protocolQuoteFee: frozen.protocolQuoteFee, creatorQuoteFee: frozen.creatorQuoteFee };
    if (b >= G) r.quoteReserve = 1n << 62n;
    if (t.missed && b !== G) { lines.push(`miss\t${b}\t${t.now}`); continue; }
    const o = tick(S, r);
    emit("tick", b, r, o, [r.sqrtPrice, r.tradingQuoteFee, r.protocolQuoteFee, r.creatorQuoteFee, r.quoteReserve, r.budgetWsol]);
  }
  must(S.phase === PHASE.GRADUATING, `pool replay: not graduating at bar ${A} (phase ${S.phase})`);
  // adopt_pool, 200 s after bar A's tick; the pool's counters already hold the trades since migration
  let lpB = 4_000_000_000n, protB = 1_000_000_000n;
  const adoptNow = tl.ticks[A].now + 200;
  const a = { sqrtPrice: frozen.sqrtPrice, lpBFee: lpB, protocolBFee: protB, liquidity: L0, status: 0, feeBytes: feeAt(A), volatilityAccumulator: 0n, quoteReserve: 100_000_000_000n, sqrtMax: MAX_SQRT_PRICE };
  adoptPool(S, { now: adoptNow, reading: a });
  lines.push(["adopt", adoptNow, tl.ticks[A].slot + 300n, a.sqrtPrice, a.lpBFee, a.protocolBFee, a.liquidity, a.status, hex(a.feeBytes), a.volatilityAccumulator, a.quoteReserve, a.sqrtMax, hex(S.signalImage), S.adoptFeeFp].join("\t"));
  // the DAMM v2 part: the tick of bar b reads the trades of the bars before it
  let sp = frozen.sqrtPrice;
  for (let b = A + 1; b <= E; b++) {
    const t = tl.ticks[b];
    const fb = feeAt(b), va = volAccAt(b);
    const r = { now: t.now, slot: t.slot, sqrtPrice: sp, lpBFee: lpB, protocolBFee: protB, liquidity: liqAt(b), status: pausedAt(b) ? 1 : 0, feeBytes: fb, volatilityAccumulator: va, quoteReserve: 100_000_000_000n, budgetWsol: 0n };
    if (missedPool.has(b)) lines.push(`miss\t${b}\t${t.now}`);
    else {
      const o = tick(S, r);
      emit("ptick", b, r, o, [r.sqrtPrice, r.lpBFee, r.protocolBFee, r.liquidity, r.status, hex(r.feeBytes), r.volatilityAccumulator, r.quoteReserve, r.budgetWsol]);
    }
    // bar b's trades (none while paused), at the fee the pool charges in bar b
    if (!pausedAt(b)) {
      const lam = BigInt(Math.round(bars.vol[b] * 1e9));
      const fee = (lam * dammFeeOf(fb, va).numerator + 999_999_999n) / 1_000_000_000n;
      const prot = (fee * 20n) / 100n;
      lpB += fee - prot; protB += prot;
      sp = sqrtPriceOf(bars.close[b]);
    }
  }
  lines.push(`end\t${S.net.brainHash()}\t${S.n}\t${S.hits}\t${S.ruleHits}\t${S.forfeits}\t${S.notScored}`);
  writeFileSync(resolve(chainDir, "pool-replay.txt"), lines.join("\n") + "\n");
  const kinds = {};
  for (const e of S.diary) { const f = new DataView(e.buffer, e.byteOffset).getUint16(38, true); for (const [k, v] of Object.entries(DF)) if (f & v) kinds[k] = (kinds[k] ?? 0) + 1; }
  return { G, A, E, S, kinds, curve: { n: S.prevN, hits: S.prevHits } };
}

// ---------- run ----------
const data = JSON.parse(readFileSync(resolve(here, "../site/data/replay.json"), "utf8"));
const coins = [{ name: "replay", t0: data.t0, close: data.close, vol: data.vol, step: data.step || 600 }];
const simDir = resolve(here, "../sim/data");
for (const f of readdirSync(simDir).filter((f) => /^ohlcv_.+\.json$/.test(f)).sort()) {
  const rows = JSON.parse(readFileSync(resolve(simDir, f), "utf8")).rows;
  if (!rows?.length) continue;
  const b = mergeBars(rows);
  coins.push({ name: f.slice(6, -5), t0: b.start, close: b.close, vol: b.vol, step: 600 });
}

console.log("v0 (chapter 0, the 8-8-1 view)");
for (const c of coins) {
  const s = exportV0(c.name, c.t0, c.step, c.close, c.vol);
  console.log(`  ${s.name.padEnd(9)} bars ${String(s.bars).padStart(5)}  training steps ${String(s.learns).padStart(5)}  forward passes ${String(s.thinks).padStart(5)}  brain ${s.hash.slice(0, 16)}`);
}
{
  // the replay engine feeds the same bars in the same order: its brain must end identical
  const engine = createReplay(data);
  engine.runToEnd(false);
  const m = createModel();
  for (let t = 0; t < data.close.length; t++) m.step({ ts: data.t0 + t * 600, close: data.close[t], vol: data.vol[t] });
  must(engine.model.brainHash() === m.brainHash(), "replay.js and the direct loop disagree");
}

console.log("v1 (10-8-8-1 with chapters, through the chain engine)");
coins.forEach((c, i) => {
  const s = exportV1(c.name, c, 11 + i);
  console.log(`  ${s.name.padEnd(9)} steps ${String(s.learns).padStart(5)}  forward ${String(s.thinks).padStart(5)}  filled bars ${String(s.fills).padStart(3)}  chapter ${s.chapter}  scored ${s.n} (hits ${s.hits}, rule ${s.rule}, forfeits ${s.forfeits})  brain ${s.hash.slice(0, 16)}`);
});

// starting weights for 256 seeds: v0 (81 numbers) and v1 (169)
{
  const seeds = [SEED, 0, 1, 2, 12345, 0xffffffff, 0x80000000];
  for (let s = 3; seeds.length < 256; s = (s * 2654435761 + 97) % 4294967296) seeds.push(s);
  writeFileSync(resolve(v0Dir, "seeds.txt"), ["# seed <81 starting weights>", ...seeds.map((s) => `${s} ${ints(createModel({ seed: s }).weightsQ())}`)].join("\n") + "\n");
  writeFileSync(resolve(v1Dir, "seeds.txt"), ["# seed <169 starting weights>", ...seeds.map((s) => `${s} ${ints(Weights.fromSeed(s).flat())}`)].join("\n") + "\n");
}

console.log("chain replay (what the program must write)");
{
  const r = exportChainReplay("replay", coins[0], 11);
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");
  console.log(`  replay: ${r.boundaries} boundary ticks, scored ${r.n} (${r.forfeits} forfeits), net ${r.hits} = ${pct(r.hits, r.n)}, rule ${r.ruleHits} = ${pct(r.ruleHits, r.n)}, busier hours ${r.busierHours}, not scored ${r.notScored}, quieter calls ${r.quieterCalls} (hits ${r.quieterHits})`);
  const memos = r.S.diary.length;
  for (const strategy of ["best-second", "skip-oracle-boundary", "skip-random-10", "steer-rule-second"]) {
    const x = exportCrankReplay("JEANPHIL", strategy);
    console.log(`  JEANPHIL, ${strategy} cranker: ${x.boundaries} boundary ticks, scored ${x.n} (${x.forfeits} forfeits), net ${x.hits} = ${pct(x.hits, x.n)}, rule ${x.ruleHits} = ${pct(x.ruleHits, x.n)}`);
  }
  console.log(`  diary entries ${memos}; last line: ${JSON.stringify(readFileSync(resolve(chainDir, "chain-replay.txt"), "utf8").trim().split("\n").filter((l) => l.startsWith("tick") && l.split("\t")[15] !== "-").pop().split("\t")[15])}`);
  const p = exportPoolReplay(coins[0], 11);
  console.log(`  pool replay: graduates at bar ${p.G}, adopt_pool after bar ${p.A}, DAMM v2 to bar ${p.E}; curve record ${p.curve.hits}/${p.curve.n}, pool record ${p.S.hits}/${p.S.n} (forfeits ${p.S.forfeits}, not scored ${p.S.notScored}); diary flags ${JSON.stringify(p.kinds)}`);
}
// ---------- the buy rules, case by case (programs/hunch/tests/host.rs checks the Rust rules) ----------
{
  let seed = 0x5eed;
  const r32 = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const rb = (bits) => { let v = 0n; for (let k = 0; k < bits; k += 32) v = (v << 32n) | BigInt(r32()); return v & ((1n << BigInt(bits)) - 1n); };
  const lines = ["# buy-rule vectors from site/core/chain.js: ratio, band, impact, quote, guard, slice, mult, fee, median"];
  for (let i = 0; i < 400; i++) {
    const a = rb(40 + (r32() % 56)) + 1n, b = (a * BigInt(900 + (r32() % 300))) / 1000n + 1n;
    const rq = ratioQ32(a, b);
    lines.push(`ratio ${a} ${b} ${rq} ${retFromRatio(rq)}`);
  }
  for (const n of [1, 2, 3, 4, 10, 24, 99, 100, 400, 623, 1000, 3032, 100000]) lines.push(`band ${n} ${luckBandBps(n)}`);
  for (let i = 0; i < 300; i++) {
    // a curve of 2-16 rising points with uneven liquidity, a price somewhere on it
    const k = 2 + (r32() % 15);
    let p = (1n << 56n) + rb(56);
    const start = p;
    const curve = [];
    for (let j = 0; j < k; j++) { p += p / BigInt(20 + (r32() % 200)) + 1n; curve.push({ sqrtPrice: p, liquidity: (rb(28) + 1n) << BigInt(60 + (r32() % 40)) }); }
    const stop = r32() % 3 === 0 ? curve[k - 1].sqrtPrice : curve[Math.max(0, k - 2)].sqrtPrice;
    const lo = start, hi = stop;
    const sp = lo + ((hi - lo) * BigInt(r32() % 1000)) / 1000n;
    const cfg = { sqrtStartPrice: start, curve, migrationSqrtPrice: stop };
    const pts = curve.map((c) => `${c.sqrtPrice} ${c.liquidity}`).join(" ");
    const cap = impactCap(sp, cfg);
    lines.push(`impact ${sp} ${stop} ${start} ${k} ${pts} ${cap}`);
    const amount = 10_000_000n + rb(36);
    const fee = [37_500_000n, 500_000_000n, 100_000_000n][r32() % 3];
    const q = quoteBuy(sp, cfg, fee, amount);
    lines.push(`quote ${sp} ${stop} ${fee} ${amount} ${k} ${pts} ${q.out} ${q.nextSqrtPrice} ${q.partial ? 1 : 0}`);
  }
  for (let i = 0; i < 300; i++) {
    const med = (1n << 60n) + rb(60), spot = (med * BigInt(900 + (r32() % 400))) / 1000n;
    const g = guardExcess(spot, med);
    lines.push(`guard ${spot} ${med} ${g === null ? -1 : g}`);
  }
  for (let i = 0; i < 200; i++) {
    const held = rb(r32() % 2 ? 26 : 40), m = [5, 10, 15][r32() % 3];
    lines.push(`slice ${held} ${m} ${plannedSlice(held, m)}`);
  }
  for (const lean of [0, 4499, 4500, 4501, 4999, 5000, 5001, 5499, 5500, 5501, 10000]) for (const c of [0, 1, 2]) lines.push(`mult ${c} ${lean} ${multiplierOf(c, lean)}`);
  const cfgFee = { activationPoint: 1_790_000_000n, cliffFeeNumerator: 500_000_000n, numberOfPeriod: 5n, periodFrequency: 1n, reductionFactor: 92_500_000n };
  for (const dt of [-5, 0, 1, 2, 3, 4, 5, 6, 100]) lines.push(`fee ${1_790_000_000 + dt} 1790000000 ${liveFeeNumerator(cfgFee, 1_790_000_000 + dt)}`);
  for (let i = 0; i < 100; i++) {
    const n = 1 + (r32() % 6), vals = Array.from({ length: n }, () => rb(64));
    lines.push(`median ${n} ${vals.join(" ")} ${medianSqrt(vals)}`);
  }
  // the diary formatter on entries the replay never produces (buys, guard waits, forfeits with a buy
  // clause, blind, graduating, ties, huge counters): line<TAB>entry hex<TAB>text
  const flagSets = [0, DF.GUARD, DF.STALE, DF.BELOW_MIN, DF.VOLUME_CAP, DF.DAY_CAP, DF.NO_ATTEMPT, DF.NO_OUTSIDE, DF.TIE, DF.GRADUATING, DF.BLIND, DF.WARMUP | DF.NO_ATTEMPT, DF.FORFEIT];
  for (let i = 0; i < 600; i++) {
    const big32 = () => (r32() % 4 === 0 ? r32() : r32() % 5000);
    const n = big32(), hits = n ? r32() % (n + 1) : 0, rule = n ? r32() % (n + 1) : 0;
    const flags = flagSets[r32() % flagSets.length] | (r32() % 3 === 0 ? DF.CHAPTER | DF.DAY_RECORD : 0) | (r32() % 5 === 0 ? flagSets[r32() % flagSets.length] : 0);
    const outcome = r32() % 5;
    const brain4 = Uint8Array.from([r32() & 255, r32() & 255, r32() & 255, r32() & 255]);
    const e = {
      hour: big32(), unixHour: r32(), slot: BigInt(r32()), call: r32() % 3, outcome, lean: r32() % 10001, n, hits, ruleHits: rule,
      nextLean: r32() % 10001, nextCall: r32() % 3, phase: r32() % 5, chapter: r32() % 4,
      detail: outcome === OUTCOME.FORFEIT && r32() % 2 ? 1 + (r32() % 30) : r32() % 256,
      flags, bought: r32() % 3 === 0 ? rb(40) : 0n, burned: rb(r32() % 2 ? 30 : 60), brain4, brain8: toHex(brain4), held: r32(),
    };
    const text = diaryLine(e);
    must(!/[\t\n]/.test(text), "a line with a tab or newline");
    lines.push(`line\t${hex(diaryEntryBytes(e))}\t${text}`);
  }
  // ---- the pool phase (DAMM v2): impact cap, quote, the fee fields, and the diary's Meteora lines ----
  for (let i = 0; i < 200; i++) {
    const sp = (1n << 50n) + rb(70), L = r32() % 7 === 0 ? 0n : rb(40 + (r32() % 60)) + 1n;
    const sqrtMax = r32() % 5 === 0 ? sp + sp / 1000n : 79226673521066979257578248091n;
    lines.push(`pimpact ${sp} ${L} ${sqrtMax} ${poolImpactCap(sp, L, sqrtMax)}`);
    const fee = [37_500_000n, 10_000_000n, 100_000_000n, 990_000_000n][r32() % 4], amount = 10_000_000n + rb(36);
    const q = quotePoolBuy(sp, L, sqrtMax, fee, amount);
    lines.push(`pquote ${sp} ${L} ${sqrtMax} ${fee} ${amount} ${q.out} ${q.nextSqrtPrice} ${q.partial ? 1 : 0}`);
  }
  for (let i = 0; i < 150; i++) {
    const dyn = r32() % 3 === 0;
    const fb = dammFeeBytes({
      cliff: [37_500_000n, 10_000_000n, 100_000_000n, 600_000_000n][r32() % 4], mode: [0, 0, 0, 1, 3][r32() % 5],
      nPeriods: r32() % 4 === 0 ? r32() % 10 : 0, frequency: BigInt(r32() % 3), reduction: BigInt(r32() % 3) * 1_000_000n,
      dynamic: dyn, maxVolatilityAccumulator: r32() % 300_000, variableFeeControl: r32() % 200_000, binStep: 1 + (r32() % 100),
      filterPeriod: 10, decayPeriod: 120, reductionFactor: 5000, feeVersion: r32() % 2,
    });
    const volAcc = r32() % 4 === 0 ? rb(100) : BigInt(r32() % 300_000);
    const f = dammFeeOf(fb, volAcc);
    lines.push(`dfee ${hex(fb)} ${volAcc} ${f.numerator} ${f.plain ? 1 : 0} ${feeFingerprint(fb)}`);
  }
  const meteoraFlags = [DF.FEE_CHANGED, DF.PAUSED, DF.FEE_CHANGED | DF.PAUSED, DF.FEE_CHANGED | DF.GUARD, DF.PAUSED | DF.NO_ATTEMPT,
    DF.FEE_CHANGED | DF.NO_ATTEMPT, DF.PAUSED | DF.VOLUME_CAP, DF.FEE_CHANGED | DF.CHAPTER, DF.PAUSED | DF.FORFEIT];
  for (let i = 0; i < 200; i++) {
    const n = r32() % 3000, hits = n ? r32() % (n + 1) : 0;
    const brain4 = Uint8Array.from([r32() & 255, r32() & 255, r32() & 255, r32() & 255]);
    const flags = meteoraFlags[r32() % meteoraFlags.length];
    const outcome = flags & DF.FORFEIT ? OUTCOME.FORFEIT : [OUTCOME.NOT_SCORED, OUTCOME.NOT_SCORED, OUTCOME.HIT][r32() % 3];
    const e = {
      hour: r32() % 9000, unixHour: r32(), slot: BigInt(r32()), call: r32() % 3, outcome, lean: r32() % 10001, n, hits, ruleHits: n ? r32() % (n + 1) : 0,
      nextLean: r32() % 10001, nextCall: r32() % 3, phase: 3, chapter: r32() % 4, detail: r32() % 256,
      flags, bought: r32() % 4 === 0 ? rb(36) : 0n, burned: rb(40), brain4, brain8: toHex(brain4), held: r32(),
    };
    lines.push(`line\t${hex(diaryEntryBytes(e))}\t${diaryLine(e)}`);
  }
  writeFileSync(resolve(chainDir, "rules.txt"), lines.join("\n") + "\n");
  console.log(`rules: ${lines.length - 1} cases`);
}
console.log(`wrote ${vecDir}/{v0,v1} and ${chainDir}`);
