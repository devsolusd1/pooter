// Kill test K7, the cranker part, plus the record against the rule, the majority and the luck band.
//
// For each coin (the rehearsal pool JEANPHIL and the six other simulated coins; MONKEY is too short to
// score), the program's rules (site/core/chain.js) run under every cranker strategy of
// crank-strategies.mjs, on pool readings modelled per second from the 5-minute candles. Prints the
// record of each strategy and its change against an honest cranker, and checks:
//   - the honest record beats the majority side by more than the luck band on at least 5 of 7 coins,
//     and scores 60% or more pooled;
//   - each chapter changes the pooled honest record by less than 1 point (chapters capped at 0, 1, 2);
//   - choosing the second inside the 30-second window (rules.rs WINDOW) changes the record by less than 1 point
//     (pooled, and on the rehearsal replay), for every realizable strategy;
//   - no realizable skipping strategy raises the record (pooled, and on the rehearsal replay).
// Oracle strategies (they know the next hour's trades) are reported as upper bounds, with a warning when
// one gains a point or more. Exits with code 1 when a check fails, so the failure shows in test-v1.sh.
//
// Usage: node hunch/scripts/k7-crank.mjs [--quick] [--window N] [--only a,b]
//   --quick     the rehearsal pool only
//   --window N  what the second-choice lever would be if ticks were accepted in the first N seconds (default: the program's 30)
//   --only      run only these strategies (honest is always run)
//   --no-gap-rule  without the rule that a missed tick in the hour before a call forfeits that call (to
//                  see what the rule buys; the program always applies it)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readingModel, runCrank, recordOf, STRATEGIES, ORACLE, WINDOW } from "./crank-strategies.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const quick = process.argv.includes("--quick");
const window = Number(arg("--window") ?? WINDOW);
const only = arg("--only") ? new Set(["honest", ...arg("--only").split(",")]) : null;
const gapRule = !process.argv.includes("--no-gap-rule");
const NAMES = Object.keys(STRATEGIES).filter((s) => !only || only.has(s));
const COINS = quick ? ["JEANPHIL"] : ["JEANPHIL", "EMBER", "FOMO", "HAMSTER", "HOOKED", "SLOPCORE", "swordcat"];
const pct = (v) => (100 * v).toFixed(1) + "%";
const pts = (v) => (v >= 0 ? "+" : "") + (100 * v).toFixed(2);

const results = {}; // strategy -> coin -> record
const capped = { 0: {}, 1: {}, 2: {} }; // the honest record with the chapters opened only up to 0, 1, 2
const chaptersToo = !only && window === WINDOW;
const t = Date.now();
for (const coin of COINS) {
  const rows = JSON.parse(readFileSync(resolve(here, `../sim/data/ohlcv_${coin}.json`), "utf8")).rows;
  const model = readingModel(rows);
  if (chaptersToo) for (const c of [0, 1, 2]) capped[c][coin] = recordOf(runCrank(model, "honest", { seed: 11, gapRule, maxChapter: c }).S);
  for (const strategy of NAMES) {
    const { S } = runCrank(model, strategy, { seed: 11, window, gapRule });
    (results[strategy] ??= {})[coin] = recordOf(S);
  }
  process.stderr.write(`  ${coin} done (${((Date.now() - t) / 1000).toFixed(0)} s)\n`);
}

const pooled = (strategy) => {
  const r = { n: 0, hits: 0, rule: 0, forfeits: 0, busier: 0, quieter: 0 };
  for (const c of COINS) { const x = results[strategy][c]; r.n += x.n; r.hits += x.hits; r.rule += x.rule; r.forfeits += x.forfeits; r.busier += x.busier; r.quieter += x.quieter; }
  return { ...r, net: r.hits / r.n, ruleAcc: r.rule / r.n, majority: Math.max(r.busier, r.quieter) / r.n, band: 1.96 * Math.sqrt(0.25 / r.n) };
};

console.log(`K7: the record of an honest cranker (ticks at second 0-${Math.min(30, window) - 1}), per coin${window !== WINDOW ? ` (window ${window} s)` : ""}`);
console.log("  coin       scored  net     rule    majority  luck band  net - majority  net - rule");
let beatMajority = 0;
for (const c of COINS) {
  const x = results.honest[c];
  const beats = x.net - x.majority > x.band;
  beatMajority += beats;
  console.log(`  ${c.padEnd(9)} ${String(x.n).padStart(6)}  ${pct(x.net).padStart(6)}  ${pct(x.ruleAcc).padStart(6)}  ${pct(x.majority).padStart(8)}  +-${(100 * x.band).toFixed(1).padStart(4)}     ${pts(x.net - x.majority).padStart(7)} ${beats ? "beats" : "     "}  ${pts(x.net - x.ruleAcc).padStart(7)}`);
}
const P = pooled("honest");
console.log(`  pooled    ${String(P.n).padStart(6)}  ${pct(P.net).padStart(6)}  ${pct(P.ruleAcc).padStart(6)}  ${pct(P.majority).padStart(8)}  +-${(100 * P.band).toFixed(1).padStart(4)}     ${pts(P.net - P.majority).padStart(7)}        ${pts(P.net - P.ruleAcc).padStart(7)}`);

const failures = [], warnings = [];
if (chaptersToo) {
  const pooledNet = (byCoin) => { let n = 0, hits = 0; for (const c of COINS) { n += byCoin[c].n; hits += byCoin[c].hits; } return hits / n; };
  const at = [0, 1, 2].map((c) => pooledNet(capped[c]));
  at.push(P.net);
  console.log(`\nK7: the pooled honest record with the chapters opened up to 0, 1, 2 and 3: ${at.map(pct).join(", ")}; chapters 1, 2 and 3 change it by ${[1, 2, 3].map((c) => pts(at[c] - at[c - 1])).join(", ")} points`);
  for (let c = 1; c <= 3; c++) if (Math.abs(at[c] - at[c - 1]) >= 0.01) failures.push(`chapter ${c} changes the pooled record by ${pts(at[c] - at[c - 1])} points`);
}

console.log("\nK7: what a cranker's choices do to the record (points against the honest cranker; forfeits count as misses)");
console.log(`  strategy                    ${COINS.map((c) => c.slice(0, 8).padStart(9)).join("")}   pooled  forfeits  what it does`);
for (const s of NAMES) {
  const row = COINS.map((c) => pts(results[s][c].net - results.honest[c].net).padStart(9)).join("");
  const p = pooled(s);
  const d = p.net - P.net;
  console.log(`  ${(ORACLE.has(s) ? "(oracle) " : "") + s}`.padEnd(39) + `${row}  ${pts(d).padStart(7)}  ${String(p.forfeits).padStart(8)}  ${STRATEGIES[s]}`);
  const replayD = results[s].JEANPHIL.net - results.honest.JEANPHIL.net;
  const list = ORACLE.has(s) ? warnings : failures;
  if (/skip/.test(s) && (d > 0 || replayD > 0)) list.push(`${s} raises the record (pooled ${pts(d)}, replay ${pts(replayD)})`);
  if (/second/.test(s) && !/skip/.test(s) && (Math.abs(d) >= 0.01 || Math.abs(replayD) >= 0.01)) list.push(`${s} moves the record by 1 point or more (pooled ${pts(d)}, replay ${pts(replayD)})`);
}

if (!gapRule) console.log("(without the gap rule: a missed ordinary tick does not forfeit the next call)");
if (!quick && window === WINDOW && !only && gapRule) {
  if (beatMajority < 5) failures.push(`the honest record beats the majority by more than the luck band on only ${beatMajority} of 7 coins`);
  if (P.net < 0.6) failures.push(`the pooled honest record is ${pct(P.net)}, under 60%`);
}
console.log(`\nbeats the majority by more than the luck band on ${beatMajority} of ${COINS.length} coins; ${((Date.now() - t) / 1000).toFixed(0)} s`);
for (const w of warnings) console.log(`K7 WARN (oracle upper bound): ${w}`);
for (const f of failures) console.log(`K7 FAIL: ${f}`);
if (failures.length) process.exitCode = 1;
else console.log("K7 checks pass");
