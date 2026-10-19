# Hunch site engine (`site/core`)

Shared by the three site variants. Plain browser ES modules, no dependencies, the same code runs in Node
(`node hunch/scripts/check.mjs`).

| File | What it is |
|---|---|
| `net.js` | The network. Version one (`createNet`, `Weights`, `Net`): 10 inputs, 8 ReLU, 8 ReLU, 1 sigmoid output, 169 weights in Q16.16 integers, sealed chapters (inputs 9-10 wake on day 7, layer 2 on day 14, learning rate 2^-8 on day 21), integer bars in lamports. Chapter 0 is exactly the 8-8-1 of `hunch/sim/sim.mjs`; `createModel()` is that chapter-0 view (81 numbers), which the rehearsal and the pages below use. The Rust program matches both bit for bit (K2). |
| `chain.js` | The program's rules in JS, integer for integer: what a tick reads from the Meteora DBC pool, Hunch's own buys taken out, the 30-second window, boundary scoring with forfeits (a missed boundary forfeits two hours; a missed tick in the 5 bars before a boundary means no call for that hour, which is forfeited), the open call (160 bytes; flag 64 = no call after a gap), the diary entry and its line, the daily brain record, and the buy plan (slice, floor, guard, caps, quote). The LiteSVM replay checks the program against it on every tick. |

### Two rules from the final program (layout: `hunch/design/layout-final.md`)

- **The ticker.** `initialize` stores the coin's ticker (1 to 10 characters, A-Z and 0-9) in `State.ticker` and the diary line names it: `bought 0.083 SOL, burned 1.20M HOURHOG.` Pass the decoded ticker: `diaryLine(entry, ticker)` (it defaults to `"HUNCH"`, which the vectors use) and `createChain({ ticker })`. `tickerOk(t)` is initialize's check.
- **One wait per hour.** A buy call that waits records why (`S.hourStatus`). After that, in the same UTC hour, a call that would wait again is refused (`planBuy` / `planBuyPool` return `{ error: "AlreadyWaitedThisHour" }`, the program's error 28) and changes nothing; a call that can buy still buys, and after a buy every call in the hour is refused (`AlreadyBoughtThisHour`). So the waits count is the number of hours that waited, not the number of crank calls.
- **Changed after review (2026-10-16).** adopt_pool's bar no longer reads the pool's permanent lock (an outsider could raise it for good and block adoption). The position must hold, locked for good, 25% of `migrationLiquidity(threshold, migrationSqrtPrice)`, the liquidity DBC's migration builds from the config's values that adopt_curve pins; `positionShareOk(locked, threshold, sqrtPrice)` is the check, and `adoptPool(S, { now, reading, positionLocked })` applies it when `positionLocked` is given. Hunch's real position is 32.93% of it. `planBuyPool` returns `{ error: "FeeRaised" }` (the program's error 30) when the pool's fee is above `S.adoptFeeNum` or not plain (`poolFeeRefused`); a lower fee is not refused. `programs/tests/export-pool-rules.mjs` checks these against the Rust rules case by case.
| `replay.js` | The rehearsal engine: plays `site/data/replay.json` (a real PumpSwap pool, not HUNCH) through `net.js`, the drip buyback, the diary, the open signal and the daily brain snapshots. |
| `sha256.js` | Synchronous SHA-256 (brain hashes). |
| `../data/replay.json` | 3,759 ten-minute bars of JEANPHIL/SOL on PumpSwap, 2026-09-19 19:00 to 2026-10-15 21:20 UTC, with a `source` block. Rebuild with `node hunch/scripts/build-replay.mjs`. |

## Rules every page must keep

- Show `REHEARSAL_LABEL` plainly and visibly: *rehearsal: replaying real market data through the real network; HUNCH is not live*. `replay.source.note` names the real pool; link it by its address (`source.pool`) if you link it at all. There is no HUNCH contract address. Never invent one.
- Dates in the replay are the real pool's dates. Show them as replay time (for example "hour 412 · replay of 2026-10-06"), never as now.
- Every accuracy figure sits next to its luck band (`stats.luck`, `stats.rolling.luck`), and the one-line rule (`stats.rule.acc`) is one press away. The network does about as well as that rule. It predicts **activity** (busier or quieter next hour), **not price**.
- `burnedEst` is an estimate (`burnIsEstimate: true`): spend x 0.9625 / the replayed pool's price. Label it "≈" or "est.".
- `reserveEst` (the pool's SOL reserve, used only for the 1% cap) is an estimate between two real readings. Do not show it as a reading.
- Snapshot `slot` is `null`: there is no chain yet. Do not make one up. Chapters (`CHAPTERS`) are provisional and **not modelled**. Show them as sealed and ahead, never as having happened in the replay.
- `macs` are real counts of the multiply-adds this engine did. Compute units are **not** measured (no program exists yet). Do not print a CU figure as measured.
- Never say the model's scaling makes the buyback buy cheaper or smarter (check.mjs: drip x1.5/x0.5 −0.21% against spending all each hour, plain drip −0.25%). No profit, edge, trading signal or advice wording.
- On this pool the 1% cap binds in most hours of days 0 to 20 (503 of 625 hourly buys). The pool traded about 30 times its reserve a day. The budget peaks near 2,870 SOL on day 3 and drains by the end. If you show the drip, show `want`, `cap` and `capped` honestly.

## Quick start

```js
import { createReplay, loadReplay, REHEARSAL_LABEL, STEPS_PER_DAY, fmtPct, fmtSol, fmtCount } from "../../core/replay.js";
import { INPUTS, LAYOUT } from "../../core/net.js";

const data = await loadReplay(new URL("../../data/replay.json", import.meta.url));
const replay = createReplay(data, { startAt: 3 * STEPS_PER_DAY, speed: 3 }); // 3 days in, 3 bars a second

// history is already filled for the first 3 days: draw it once
for (const d of replay.history.diary.slice(-8)) addDiaryLine(d.text);

replay.on("think", (e) => drawNetwork(e.x, e.h, e.p));             // every 10-minute bar
replay.on("call", (e) => showCall(e.call, e.confidence, e.brain)); // on the hour
replay.on("diary", (e) => addDiaryLine(e.text));
replay.on("learn", (e) => flashWeights(e.changed));                // [[index, delta], ...]
replay.on("stats", (s) => showAccuracy(fmtPct(s.acc), fmtPct(s.luck.lo), fmtPct(s.luck.hi)));
replay.on("seek", () => redrawEverything(replay));

replay.play();
// replay.pause(); replay.toggle(); replay.setSpeed(12); replay.step(); replay.seek(0);
```

Speeds are bars per second. The real pace is `1 / 600` (one bar per 10 minutes). Playback uses `requestAnimationFrame`, so it pauses in a hidden tab. After a long gap it catches up by at most `maxStepsPerFrame` bars and drops the rest of the backlog.

## `net.js`

Version one, as the program runs it (the chapter is passed in; inputs 9 and 10 are 0 before chapter 1):

```js
import { createNet, Weights, chapterOf, LAYOUT_V1, INPUTS_V1 } from "./net.js";
const n = createNet();                                  // seed 12346: 64 + 8 numbers from the LCG, layer 2 the identity
n.feed({ ts, retQ, lam, x9, x10 }, fill);               // a landed bar (fill = false) or a missed one (fill = true)
n.learn(chapter); n.think();                            // one gradient step on the sample 6 bars back; the forward pass
n.step(bar, chapter);                                   // feed + learn + think
n.weights.flat();                                       // 169 numbers in LAYOUT_V1 order; n.bytes() = 676 bytes, n.brainHash()
```

The chapter-0 view the pages use:

```js
import { createModel, INPUTS, LAYOUT, ONE, hashWeights, weightsToBytes } from "./net.js";
const m = createModel();              // { seed = 12346, lrShift = 7 }: the canonical brain
m.feed({ ts, close, vol });           // one 10-minute bar -> { t, x: 8 Q16.16 ints | null, move }
m.pending();                          // sample 6 bars back whose outcome is now known -> { t, x, y: 1|0|null, came, nextVol, lastVol }
m.learn();                            // one gradient step on it -> { sample, y, p, error, changed: [[i, delta]], maxDelta, dead, macs, version } | null
m.think();                            // forward on the current bar -> { x, xQ, z1, h, z2, p, pQ, call: "busy"|"quiet", confidence, rule } | null
m.step(bar);                          // feed + learn + think, the order the simulation uses
m.call();                             // { call, confidence, p } from the last think
m.activations();                      // the last think result
m.weights();  m.weightsQ();           // 81 numbers in LAYOUT order (floats / Q16.16 ints)
m.bytes();                            // 324 bytes, little-endian i32
m.brainHash(); m.brainId();           // SHA-256 hex of the bytes / its first 4 hex chars
m.forward(xQ);                        // raw forward on any 8 Q16.16 inputs (no state change except the macs counter)
m.version; m.macs;                    // training steps so far / multiply-adds so far
```

- `p` is the network's probability that the next hour is busier. `call` is `busy` when `p >= 0.5`. `confidence = max(p, 1 - p)`, from 0.50 to 1.00.
- No inputs exist for the first 12 bars (2 hours). The first training step happens at bar 18.
- `INPUTS[i]` gives `{ key, label, formula }` for the 8 inputs: last move, hour move, bar volume, hour volume vs usual, hour volume vs the hour before, churn, clock sin and clock cos. They are clipped to [-4, 4] and the clock pair runs from -1 to 1.
- `LAYOUT` gives the flat weight order. `W1` input i to hidden j is at `j*8 + i` (0 to 63). `b1` is at 64 to 71, `W2` at 72 to 79 and `b2` at 80. Each weight stays within [-8, 8].
- `rule` is the one-line rule's call for the same bar: busier if the last hour was below its usual level, i.e. input 3 < 0.

## `replay.js`

`createReplay(data, options)` takes these options. Defaults are shown.

| option | default | |
|---|---|---|
| `speed` | `2` | bars per second while playing |
| `startAt` | `0` | step to start from, computed silently (history kept), e.g. `3 * STEPS_PER_DAY` |
| `rollingWindow` | `48` | hourly calls in `stats.rolling` |
| `learnKeep` | `144` | learn events kept in `history.learns` |
| `loop` | `false` | at the end, jump back to `startAt` (fresh brain) and keep playing |
| `drip` | `DRIP` | override the rule constants only to explore; the defaults are the design |

The replay object has these methods and getters:

- `play()`, `pause()`, `toggle()`, `setSpeed(sps)`, `step()` (one bar, with events), `seek(step)` (silent; backwards rebuilds from 0) and `restart()`. `runToEnd(live = false)` returns the final stats.
- `on(type, fn)` returns an unsubscribe function. `type` is an event name or `"*"`. `fn(event, replay)`.
- `playing`, `speed`, `position` (bars done), `done`, `steps` (3759), `model` (the live `net.js` model), `stats`, `signal`, `history`, `budget`.
- `source` is the real pool block, and `label` is `REHEARSAL_LABEL`. `rules` holds the drip constants, `fee` is `FEE` and `chapters` is `CHAPTERS`.
- `timeOf(step)`, `hourOf(step)` and `reserveEstAt(step)`.
- `history.diary`, `.calls` (each call gets `came`/`hit` set once resolved), `.drips` and `.snapshots` (with weights) are complete. `.learns` holds only the last `learnKeep`. `history.series.{p, budget, spent, burned, acc}` are typed arrays indexed by step, filled up to `position` (`p` and `acc` are `NaN` where undefined).
- `signal` is the open signal account as it would read: `{ call, confidence, p, hour, brain, ts, step }`.

Constants: `FEE` (`total 0.0375, meteora 0.0075, hunch 0.0099, developer 0.0201`), `DRIP` (`share 1/6, quiet 1.5, busy 0.5, capOfReserve 0.01, burnFactor 0.9625`), `CHAPTERS`, `STEPS_PER_HOUR` 6 and `STEPS_PER_DAY` 144. Helpers: `luckBand(n)` gives `{ n, half, lo, hi }`, and `fmtSol`, `fmtCount` (1.2M), `fmtPct` and `diaryLine` format values.

### Events, in the order they fire within one bar

```js
{ type: "observe", step, ts, hour, day, close, vol, move, added, budget, reserveEst }
//   every bar. close in SOL per token, vol in SOL, move = the bar's return, added = 0.99% of vol joining the budget

{ type: "outcome", step, ts, hour, callStep, call, came: "busy"|"quiet"|null, hit, rule, ruleHit, lastHourVol, nextHourVol }
//   on the hour, for the call made one hour earlier (came null = exact tie, not scored; none in this data)

{ type: "diary", step, ts, hour, call, came, hit, confidence, spend, burnedEst, burnIsEstimate: true, brain, text }
//   right after its outcome. text is exactly:
//   "hour 412: called busy, came quiet, confidence 0.61, bought back 0.08 SOL, burned 1.2M HUNCH, brain #a3f1"
//   (hour = the hour that was called; spend/burn = that hour's buy; brain = the brain that made the call)

{ type: "learn", step, ts, sample, y, p, error, changed: [[index, delta], ...], maxDelta, dead, macs, version, brain }
//   every bar from bar 18: one gradient step on the sample 6 bars back. p/error are from the training forward pass,
//   delta in weight units (floats), dead = hidden units that were off (their incoming weights did not move)

{ type: "think", step, ts, x: [8], z1: [8], h: [8], z2, p, lean, confidence }
//   every bar from bar 12: the forward pass on this bar's inputs (floats), after learning

{ type: "call", step, ts, hour, call, p, confidence, inputs: [8], inputsQ: [8], hidden: [8], z1: [8], z2, brain, rule, came, hit, spend, burnedEst }
//   on the hour: the published call (came/hit/spend/burnedEst fill in later on the stored object)

{ type: "drip", step, ts, hour, call, added, held, share, factor, want, cap, capped, spend, price, burnedEst, burnIsEstimate: true, budget }
//   right after each call: want = held/6 x 1.5 (quiet) or 0.5 (busy); cap = 1% of reserveEst; spend = min(want, cap, held)
//   added = budget accrued since the previous drip. The drip starts with the first call (hour 2).

{ type: "snapshot", step, ts, day, hash, brain, slot: null, weightsQ: [81], weights: [81] }
//   at launch (day 0, the brain at birth) and every 24 h after; hashWeights(weightsQ) === hash

{ type: "stats", step, ts, hour, day, steps, calls, scored, hits, acc, luck: { n, half, lo, hi },
  rolling: { window, n, hits, acc, luck }, naive: { busier, quieter, acc }, rule: { hits, acc },
  budget, added, spent, burnedEst, burnIsEstimate: true, buys, capped, brain, version, macs }
//   every bar. naive = the majority side in hindsight
```

Playback events: `play`, `pause`, `speed`, `seek` (`{ step, stats }`, redraw from `history`) and `end`.

## What the check prints (full replay)

The port is exact. On the raw candles it gives the same numbers as the simulation: 601 hourly calls at 65.22%, every bar at 63.20%, the rule at 64.23%. The replay's rounding changes none of the 3,747 per-bar calls.

On the replay, 624 scored hourly calls reach 65.06% (luck band 46.1 to 53.9%). The naive baseline is 53.0% and the one-line rule 64.3%. The budget took in 6,993 SOL and spent 6,971 SOL, burning about 166M tokens (an estimate). There are 27 daily snapshots. Two runs give the same brain hash.
