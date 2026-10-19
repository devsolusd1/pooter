// Checks the site's engine (site/core) in Node:
//  1. exact port: on the raw candles, net.js reproduces sim.mjs's activity results for the pool;
//  2. the rehearsal replay (site/data/replay.json): accuracy against the naive baseline, the
//     one-line rule and the luck band; budget, spend and burn totals;
//  3. determinism: two runs end on the same brain hash and write the same diary;
//  5. chain.js mirrors the final program: one wait per hour (a second wait refused, a buy after a
//     wait allowed) and the diary line naming the ticker initialize stored.
// Usage: node hunch/scripts/check.mjs

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createModel, hashWeights, H, ONE, SIN, COS, SIG } from "../site/core/net.js";
import { createReplay, luckBand, fmtPct, fmtSol, fmtCount, DRIP, FEE } from "../site/core/replay.js";
import { sha256Text, toHex } from "../site/core/sha256.js";
import { mergeBars } from "./build-replay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const replayPath = resolve(here, "../site/data/replay.json");
const data = JSON.parse(readFileSync(replayPath, "utf8"));
const POOL = data.source.symbol;
const WARM = 150; // sim.mjs scores calls from bar 150 (about a day)
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failures++; };
const pct = (v) => fmtPct(v, 2);

// ---------- 0. sealed tables equal what sim.mjs computes ----------
console.log("tables");
{
  const toQ = (x) => Math.round(x * ONE);
  const s = [], c = [], g = [];
  for (let h = 0; h < 24; h++) { s.push(toQ(Math.sin((2 * Math.PI * h) / 24))); c.push(toQ(Math.cos((2 * Math.PI * h) / 24))); }
  for (let k = 0; k <= 32; k++) g.push(toQ(1 / (1 + Math.exp(-(k * 0.5 - 8)))));
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  ok(same(s, SIN) && same(c, COS) && same(g, SIG), "SIN, COS and sigmoid tables match sim.mjs");
}

// ---------- 1. exact port on the raw candles ----------
function runModelOnBars(t0, close, vol) {
  const n = close.length, m = createModel();
  const calls = new Array(n).fill(null), rule = new Array(n).fill(null), Y = new Array(n).fill(null);
  for (let t = 0; t < n; t++) {
    const { thought } = m.step({ ts: t0 + t * 600, close: close[t], vol: vol[t] });
    const pend = m.pending();
    if (pend && pend.y != null) Y[pend.t] = pend.y;
    if (thought) { calls[t] = thought.call === "busy" ? 1 : 0; rule[t] = thought.rule === "busy" ? 1 : 0; }
  }
  return { calls, rule, Y, model: m, n };
}
function score(calls, Y, t0, from, step) {
  while (step > 1 && (t0 + from * 600) % 3600 !== 0) from++;
  let n = 0, hit = 0, ones = 0;
  for (let t = from; t < calls.length; t += step) {
    if (calls[t] == null || Y[t] == null) continue;
    n++; if (calls[t] === Y[t]) hit++; if (Y[t] === 1) ones++;
  }
  return { n, acc: n ? hit / n : null, majority: n ? Math.max(ones, n - ones) / n : null };
}

console.log(`\n1. exact port: net.js on the raw ${POOL} candles vs sim/result-lr7.json`);
const rawPath = resolve(here, `../sim/data/ohlcv_${POOL}.json`);
const simPath = resolve(here, "../sim/result-lr7.json");
if (existsSync(rawPath) && existsSync(simPath)) {
  const raw = mergeBars(JSON.parse(readFileSync(rawPath, "utf8")).rows);
  const R = runModelOnBars(raw.start, raw.close, raw.vol);
  const hourly = score(R.calls, R.Y, raw.start, WARM, H);
  const allBars = score(R.calls, R.Y, raw.start, WARM, 1);
  const ruleS = score(R.rule, R.Y, raw.start, WARM, H);
  const simPool = JSON.parse(readFileSync(simPath, "utf8")).pools.find((p) => p.name === POOL);
  const A = simPool.tasks.activity;
  const r4 = (v) => +v.toFixed(4);
  console.log(`  hourly calls  n ${hourly.n}  acc ${pct(hourly.acc)}   sim: n ${A.n}  acc ${pct(A.acc)}`);
  console.log(`  every bar     n ${allBars.n}  acc ${pct(allBars.acc)}   sim: n ${A.nAllBars}  acc ${pct(A.accAllBars)}`);
  console.log(`  one-line rule acc ${pct(ruleS.acc)}   sim: ${pct(A.rules.belowLevel.acc)}`);
  console.log(`  majority      ${pct(hourly.majority)}   sim: ${pct(A.majority)}`);
  ok(hourly.n === A.n && r4(hourly.acc) === A.acc, "hourly accuracy identical to the simulation");
  ok(allBars.n === A.nAllBars && r4(allBars.acc) === A.accAllBars, "every-bar accuracy identical to the simulation");
  ok(r4(ruleS.acc) === A.rules.belowLevel.acc && r4(hourly.majority) === A.majority, "rule and majority identical to the simulation");
  // effect of the rounding in replay.json
  const Rr = runModelOnBars(data.t0, data.close, data.vol);
  let same = 0, both = 0;
  for (let t = 0; t < R.n; t++) if (R.calls[t] != null) { both++; if (R.calls[t] === Rr.calls[t]) same++; }
  console.log(`  replay.json rounding: ${same} of ${both} per-bar calls unchanged (${pct(same / both)}), final brain raw #${R.model.brainId()} vs rounded #${Rr.model.brainId()}`);
} else {
  console.log("  skipped: raw candles or sim results not found");
}

// ---------- 2. the rehearsal replay ----------
console.log(`\n2. rehearsal replay: ${data.source.note}`);
console.log(`  pool ${data.source.pool} (${data.source.dex}), ${data.source.from} -> ${data.source.to}, ${data.source.bars} bars`);
function runReplay() {
  const r = createReplay(data);
  const counts = {};
  r.on("*", (e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
  const stats = r.runToEnd(true);
  return { r, stats, counts };
}
const t1 = Date.now();
const A1 = runReplay();
const ms = Date.now() - t1;
const s = A1.stats, h = A1.r.history;
const simWin = h.calls.filter((c) => c.step >= WARM && c.hit != null);
const simWinAcc = simWin.filter((c) => c.hit).length / simWin.length;
console.log(`  ran ${data.close.length} steps in ${ms} ms; events: ${Object.entries(A1.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`  hourly calls ${s.calls}, scored ${s.scored}, hits ${s.hits}`);
console.log(`  accuracy     ${pct(s.acc)}  (all calls from hour ${h.calls[0].hour})`);
console.log(`  luck band    ${pct(s.luck.lo)} .. ${pct(s.luck.hi)}  (95% of coin flips over ${s.luck.n} calls)`);
console.log(`  naive        ${pct(s.naive.acc)}  (majority side in hindsight: ${s.naive.busier} busier, ${s.naive.quieter} quieter)`);
console.log(`  one-line rule ${pct(s.rule.acc)}  ("busier if the last hour was below its usual level")`);
console.log(`  rolling      ${pct(s.rolling.acc)} over the last ${s.rolling.n} calls, luck band ${pct(s.rolling.luck.lo)} .. ${pct(s.rolling.luck.hi)}`);
console.log(`  sim window   ${pct(simWinAcc)} on ${simWin.length} calls from bar ${WARM} (simulation figure for this pool: 65.22%)`);
ok(Math.abs(simWinAcc - 0.6522) < 0.01, "replay accuracy within 1 point of the simulation's 65.2%");
const avgPrice = s.spent / h.drips.reduce((a, d) => a + (d.spend > 0 ? d.spend / d.price : 0), 0);
console.log(`  budget in    ${fmtSol(s.added)} SOL (${FEE.hunch * 100}% of ${fmtSol(s.added / FEE.hunch)} SOL traded)`);
console.log(`  spent        ${fmtSol(s.spent)} SOL in ${s.buys} hourly buys (${s.capped} capped at 1% of the estimated reserve), held at end ${fmtSol(s.budget)} SOL`);
const firstCall = h.calls[0].step, nSteps = data.close.length;
console.log(`  reserve est  ${fmtSol(A1.r.reserveEstAt(firstCall))} SOL at the first call, ${fmtSol(A1.r.reserveEstAt(Math.floor(nSteps / 2)))} mid-window, ${fmtSol(A1.r.reserveEstAt(nSteps - 1))} at the end (reading: ${data.source.reserve.end?.sol ?? "-"} SOL)`);
const capDays = new Map();
for (const d of h.drips) { const day = Math.floor((d.ts - data.t0) / 86400); const v = capDays.get(day) || [0, 0]; v[0]++; if (d.capped) v[1]++; capDays.set(day, v); }
console.log(`  capped hours by day: ${[...capDays.values()].map(([a, b]) => b).join(" ")}`);
let peak = 0, peakAt = 0;
h.series.budget.forEach((v, t) => { if (v > peak) { peak = v; peakAt = t; } });
console.log(`  budget peak  ${fmtSol(peak)} SOL held on day ${Math.floor((peakAt * 600) / 86400)}`);
console.log(`  burned       ${fmtCount(s.burnedEst)} tokens (estimate: spend x ${DRIP.burnFactor} / price), average buy price ${avgPrice.toPrecision(4)} SOL`);
console.log(`  snapshots    ${h.snapshots.length} daily, day 0 brain #${h.snapshots[0].brain}, last day ${h.snapshots.at(-1).day} brain #${h.snapshots.at(-1).brain}`);
console.log(`  weights      ${s.version} training steps, ${s.macs.toLocaleString("en-US")} multiply-adds`);
console.log(`  diary first  ${h.diary[0].text}`);
console.log(`  diary last   ${h.diary.at(-1).text}`);
const shape = /^hour \d+: called (busy|quiet), came (busy|quiet), confidence 0\.\d\d, bought back [\d.e-]+ SOL, burned [\d.]+[KMB]? HUNCH, brain #[0-9a-f]{4}$/;
ok(h.diary.every((d) => shape.test(d.text)), `all ${h.diary.length} diary lines have the required shape`);
// snapshots prove which brain they show
ok(h.snapshots.every((sn) => hashWeights(sn.weightsQ) === sn.hash), `all ${h.snapshots.length} snapshot hashes re-derive from their weights`);

// What the buyback rule does, for the record (the model's scaling is not claimed to buy smarter).
function ruleRun(kind) {
  let B = 0, spent = 0, tok = 0;
  const callAt = new Map(h.calls.map((c) => [c.step, c.call]));
  for (let t = 0; t < data.close.length; t++) {
    B += FEE.hunch * data.vol[t];
    const c = callAt.get(t);
    if (!c) continue;
    const want = kind === "even" ? B : B * DRIP.share * (kind === "drip" ? (c === "quiet" ? DRIP.quiet : DRIP.busy) : 1);
    const amt = Math.min(want, B, DRIP.capOfReserve * A1.r.reserveEstAt(t));
    B -= amt; spent += amt; tok += amt / data.close[t];
  }
  return { spent, avg: spent / tok };
}
const ev = ruleRun("even"), dp = ruleRun("plain"), dq = ruleRun("drip");
console.log(`  buy price vs spending all each hour (same cap): drip x1.5/x0.5 ${pct(dq.avg / ev.avg - 1)}, plain drip ${pct(dp.avg / ev.avg - 1)}`);
ok(Math.abs(dq.spent - s.spent) < 1e-6, "independent rerun of the drip spends the same SOL as the engine");

// ---------- 3. determinism ----------
console.log("\n3. determinism");
const A2 = runReplay();
const diaryHash = (r) => toHex(sha256Text(r.history.diary.map((d) => d.text).join("\n")));
const snapHash = (r) => toHex(sha256Text(r.history.snapshots.map((x) => x.hash).join("")));
console.log(`  run 1: brain ${A1.r.model.brainHash()}`);
console.log(`  run 2: brain ${A2.r.model.brainHash()}`);
ok(A1.r.model.brainHash() === A2.r.model.brainHash(), "final weights hash identical");
ok(diaryHash(A1.r) === diaryHash(A2.r) && snapHash(A1.r) === snapHash(A2.r), `diary (${diaryHash(A1.r).slice(0, 12)}) and snapshots identical`);
// jumping ahead gives the same state as playing through
const J = createReplay(data, { startAt: 3 * 144 });
const P = createReplay(data); for (let i = 0; i < 3 * 144; i++) P.step();
ok(J.model.brainHash() === P.model.brainHash() && J.history.diary.length === P.history.diary.length, "starting 3 days in equals stepping 432 bars");
P.seek(100); const back = P.model.brainHash(); const F = createReplay(data, { startAt: 100 });
ok(back === F.model.brainHash(), "seeking backwards rebuilds the same brain");

// ---------- 4. playback timer (setTimeout fallback in Node, requestAnimationFrame in a browser) ----------
console.log("\n4. playback");
{
  const r = createReplay(data, { startAt: 432, speed: 200 });
  const seen = [];
  r.on("diary", (e) => seen.push(e.text));
  const from = r.position;
  r.play();
  await new Promise((res) => setTimeout(res, 300));
  r.pause();
  const moved = r.position - from;
  console.log(`  200 steps/s for 300 ms: ${moved} steps, ${seen.length} diary lines, e.g. "${seen[0] ?? "-"}"`);
  ok(moved > 20 && moved < 120 && !r.playing, "plays at about the set speed and pauses");
}

// ---------- 5. the program's final rules in chain.js: one wait per hour, the ticker ----------
console.log("\n5. chain.js: one wait per hour, the ticker");
{
  const { createChain, adopt, tick, planBuy, SKIP, HOUR, diaryLine, tickerOk, OUTCOME, CALL } = await import("../site/core/chain.js");
  const { poolTimeline, standardMisses, testConfig } = await import("./pool-timeline.mjs");
  const tl = poolTimeline({ t0: data.t0, close: data.close, vol: data.vol }, { missed: standardMisses(data.close.length, 17), seed: 11 });
  const S = createChain({ ticker: "HOURHOG" });
  adopt(S, { now: tl.adoptTs, cfg: testConfig(tl.activation) });
  let boundaries = 0, hours = 0, refused = 0, bought = 0, bad = 0;
  for (const r of tl.ticks) {
    if (r.missed || !tick(S, { ...r, budgetWsol: 5_000_000_000n }).boundary || ++boundaries < 4) continue;
    const now = r.now + 60, Hh = Math.floor(now / HOUR), reserve = 1_000_000_000n;
    if (hours % 2 === 0) {
      // a deep pool and a busy previous hour, so the hour's later plan can buy (as k5-caps.mjs does)
      const L = (10n ** 12n << 128n) / r.sqrtPrice;
      S.cfg = { ...S.cfg, sqrtStartPrice: 1n, curve: [{ sqrtPrice: 1n << 120n, liquidity: L }], migrationSqrtPrice: 1n << 120n, migrationQuoteThreshold: 1n << 62n };
      S.hourVolPrev = 10n ** 13n;
    }
    // the hour's first plan waits (below 0.01 SOL); the program records it in hourStatus
    const first = planBuy(S, { now, held: 1n, sqrtPrice: r.sqrtPrice, quoteReserve: reserve });
    if (first.skip !== SKIP.BELOW_MIN) { bad++; continue; }
    S.hourStatus = { hour: Hh, reason: first.skip, detail: 0, held: 1n, bought: 0n, burned: 0n };
    // a second plan that would wait again is refused; one that can buy is not
    if (planBuy(S, { now: now + 10, held: 1n, sqrtPrice: r.sqrtPrice, quoteReserve: reserve }).error === "AlreadyWaitedThisHour") refused++;
    else bad++;
    const args = { now: now + 20, held: 5_000_000_000n, sqrtPrice: r.sqrtPrice, quoteReserve: reserve };
    const saved = S.hourStatus;
    S.hourStatus = { ...saved, hour: 0 };
    const free = planBuy(S, args);
    S.hourStatus = saved;
    const gated = planBuy(S, args);
    if (free.skip === undefined) { if (gated.slice === free.slice) bought++; else bad++; }
    else if (gated.error !== "AlreadyWaitedThisHour") bad++;
    if (++hours >= 20) break;
  }
  console.log(`  ${hours} hours: ${refused} second waits refused, ${bought} later plans that could buy allowed`);
  ok(hours === 20 && refused === 20 && bought > 0 && bad === 0, "a second wait in an hour is refused, a buy after a wait is not (processor.rs record_skip)");
  const e = { hour: 7, call: CALL.QUIETER, outcome: OUTCOME.HIT, lean: 4200, n: 5, hits: 3, ruleHits: 2, nextCall: 0, nextLean: 0, flags: 0, detail: 0, bought: 83_000_000n, burned: 1_204_000_000_000n, held: 1000, brain8: "00000000" };
  const line = diaryLine(e, "HOURHOG");
  console.log(`  ${line}`);
  let threw = false;
  try { createChain({ ticker: "hunch" }); } catch { threw = true; }
  ok(line.includes(" burned 1.20M HOURHOG. ") && diaryLine(e) === line.replace("HOURHOG", "HUNCH") && threw
    && tickerOk("HOURHOG") && tickerOk("0123456789") && !tickerOk("") && !tickerOk("ABCDEFGHIJK") && !tickerOk("hunch") && !tickerOk("HUN-CH"),
    "the diary line names the ticker; tickers are 1 to 10 of A-Z and 0-9 (initialize's rule)");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
