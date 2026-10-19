// Rehearsal engine: replays a real pool's 10-minute bars (site/data/replay.json) through the real
// network (net.js) and the real buyback rule, and emits what Hunch's program would do and write.
// It is a replay, not chain data: every page that uses it must say so (see REHEARSAL_LABEL).

import { createModel, H, BAR_SECONDS, ONE } from "./net.js";

export const REHEARSAL_LABEL = "rehearsal: replaying real market data through the real network; HUNCH is not live";
export const STEPS_PER_HOUR = H;           // 6 bars of 10 minutes
export const STEPS_PER_DAY = 24 * H;       // 144

// Money rules (fractions of each trade's quote amount, or of the held budget)
export const FEE = {
  total: 0.0375,        // the coin's trading fee (3.75%; 2% + 1% net after Meteora's 20%)
  meteora: 0.0075,      // Meteora keeps 20% of the fee
  hunch: 0.0099,        // creator share 33 of the 3% left: to the budget only Hunch's program can spend (buy HUNCH and burn it)
  developer: 0.0201,    // to the developer (67 of the 3% left)
};
export const DRIP = {
  share: 1 / 6,         // each hour spend one sixth of what is held
  quiet: 1.5,           // x1.5 when the model calls a quiet hour
  busy: 0.5,            // x0.5 when it calls a busy one
  capOfReserve: 0.01,   // each buy capped at about 1% of the pool's SOL reserve
  burnFactor: 0.9625,   // burned estimate = spend x 0.9625 / price (the 3.75% fee leaves the buy)
};
// Sealed chapters (days after launch). Provisional, and NOT modelled in this rehearsal:
// the replayed network stays 8-8-1 the whole time.
export const CHAPTERS = [
  { day: 14, what: "second hidden layer", provisional: true, modelled: false },
  { day: 21, what: "inputs from its own past errors", provisional: true, modelled: false },
];

// 95% luck band: a coin flip over n calls lands inside 50% +- half this often.
export function luckBand(n) {
  if (!n) return { n: 0, half: null, lo: null, hi: null };
  const half = 1.96 * Math.sqrt(0.25 / n);
  return { n, half, lo: 0.5 - half, hi: 0.5 + half };
}

// ---------- formatting shared by the pages (and the diary line) ----------
export function fmtSol(v) {
  if (!v) return "0";
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 0.01) return v.toFixed(2);
  return v.toPrecision(2);
}
export function fmtCount(v) {
  const a = Math.abs(v);
  const s = (x) => String(+x.toPrecision(3));
  if (a >= 1e9) return s(v / 1e9) + "B";
  if (a >= 1e6) return s(v / 1e6) + "M";
  if (a >= 1e3) return s(v / 1e3) + "K";
  return String(Math.round(v));
}
export const fmtPct = (v, d = 1) => (v == null ? "-" : (v * 100).toFixed(d) + "%");
export function diaryLine(e) {
  return `hour ${e.hour}: called ${e.call}, came ${e.came ?? "level"}, confidence ${e.confidence.toFixed(2)}, ` +
    `bought back ${fmtSol(e.spend)} SOL, burned ${fmtCount(e.burnedEst)} HUNCH, brain #${e.brain}`;
}

// ---------- loading ----------
export async function loadReplay(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`replay data: HTTP ${res.status}`);
  return res.json();
}

// Pool SOL reserve estimate for step t: S = sqrt(k x price) on a constant-product curve, with k
// running from the opening (tokens^2 x first price) to the reading at the end of the window,
// interpolated in log by cumulative volume. An estimate, used only for the 1% buy cap.
function reserveFn(data) {
  const r = data.source?.reserve;
  if (!r?.start) return () => Infinity;
  const k0 = r.start.tokens * r.start.tokens * r.start.price;
  const k1 = r.end ? r.end.sol * r.end.tokens : k0;
  const cum = new Float64Array(data.vol.length);
  let c = 0;
  for (let t = 0; t < data.vol.length; t++) { c += data.vol[t]; cum[t] = c; }
  const lk0 = Math.log(k0), dl = Math.log(k1) - lk0;
  return (t) => Math.sqrt(Math.exp(lk0 + (c ? (dl * cum[t]) / c : 0)) * data.close[t]);
}

// ---------- the replay ----------
export function createReplay(data, opts = {}) {
  const o = {
    speed: 2,              // steps (10-minute bars) per second while playing
    startAt: 0,            // step to start from (computed silently, history kept)
    rollingWindow: 48,     // hourly calls in the rolling accuracy
    learnKeep: 144,        // learn events kept in history (they carry weight deltas)
    loop: false,           // at the end, go back to startAt and play again
    maxStepsPerFrame: 240,
    ...opts,
  };
  const drip = { ...DRIP, ...(opts.drip || {}) };   // rule constants; override only to explore
  const n = data.close.length;
  const t0 = data.t0, stepSec = data.step || BAR_SECONDS;
  const hour0 = Math.floor(t0 / 3600) * 3600;
  const reserveOf = reserveFn(data);
  const listeners = new Map();
  let S;            // all mutable state, rebuilt by reset()

  function reset() {
    S = {
      i: 0,                         // next step to process
      model: createModel(o.model),
      budget: 0, added: 0, spent: 0, burnedEst: 0, buys: 0, capped: 0, hourAdded: 0,
      calls: 0, scored: 0, hits: 0, busier: 0, quieter: 0, ruleHits: 0, recent: [],
      pendingCalls: new Map(),      // step -> call event, waiting for its outcome
      signal: null,                 // the open signal account
      stats: null,
      history: {
        diary: [], calls: [], snapshots: [], drips: [], learns: [],
        series: {
          p: new Float32Array(n).fill(NaN),          // network's busy probability per bar
          budget: new Float64Array(n),               // SOL held after the bar
          spent: new Float64Array(n),                // cumulative SOL spent
          burned: new Float64Array(n),               // cumulative HUNCH burned (estimate)
          acc: new Float32Array(n).fill(NaN),        // total accuracy after the bar
        },
      },
    };
  }

  function emit(e, live) {
    if (!live) return;
    for (const key of [e.type, "*"]) {
      const set = listeners.get(key);
      if (set) for (const fn of set) fn(e, api);
    }
  }

  // process one bar
  function advance(live) {
    if (S.i >= n) return false;
    const t = S.i++;
    const ts = t0 + t * stepSec;
    const close = data.close[t], vol = data.vol[t];
    const hour = Math.floor((ts - hour0) / 3600);
    const day = Math.floor((ts - t0) / 86400);
    const onHour = ts % 3600 === 0;
    const m = S.model;
    const H_ = S.history;

    // observe(): append the bar to the tape; the fee share joins the budget
    const fed = m.feed({ ts, close, vol });
    const added = FEE.hunch * vol;
    S.budget += added; S.added += added; S.hourAdded += added;
    const reserveEst = reserveOf(t);
    emit({ type: "observe", step: t, ts, hour, day, close, vol, move: fed.move, added, budget: S.budget, reserveEst }, live);

    // train(): score the hourly call whose hour just closed, then one gradient step
    const pend = m.pending();
    if (pend) {
      const c = S.pendingCalls.get(pend.t);
      if (c) {
        S.pendingCalls.delete(pend.t);
        const came = pend.came;
        const hit = came == null ? null : came === c.call;
        const ruleHit = came == null ? null : came === c.rule;
        c.came = came; c.hit = hit;
        if (came != null) {
          S.scored++; if (hit) S.hits++; if (ruleHit) S.ruleHits++;
          if (came === "busy") S.busier++; else S.quieter++;
          S.recent.push(hit ? 1 : 0); if (S.recent.length > o.rollingWindow) S.recent.shift();
        }
        emit({ type: "outcome", step: t, ts, hour: c.hour, callStep: c.step, call: c.call, came, hit, rule: c.rule, ruleHit,
          lastHourVol: pend.lastVol, nextHourVol: pend.nextVol }, live);
        const d = {
          type: "diary", step: t, ts, hour: c.hour, call: c.call, came, hit, confidence: c.confidence,
          spend: c.spend, burnedEst: c.burnedEst, burnIsEstimate: true, brain: c.brain,
        };
        d.text = diaryLine(d);
        H_.diary.push(d);
        emit(d, live);
      }
    }
    const learned = m.learn();
    if (learned) {
      const e = { type: "learn", step: t, ts, ...learned, brain: m.brainId() };
      H_.learns.push(e); if (H_.learns.length > o.learnKeep) H_.learns.shift();
      emit(e, live);
    }

    // the network's view of this bar (every 10 minutes)
    const th = m.think();
    if (th) {
      H_.series.p[t] = th.p;
      emit({ type: "think", step: t, ts, x: th.x, z1: th.z1, h: th.h, z2: th.z2, p: th.p, lean: th.call, confidence: th.confidence }, live);
    }

    // on the hour: publish the call, then the drip buys and burns
    if (onHour && th) {
      const brain = m.brainId();
      const c = {
        type: "call", step: t, ts, hour, call: th.call, p: th.p, confidence: th.confidence,
        inputs: th.x, inputsQ: th.xQ, hidden: th.h, z1: th.z1, z2: th.z2, brain, rule: th.rule,
        came: undefined, hit: undefined, spend: 0, burnedEst: 0,
      };
      S.calls++;
      S.pendingCalls.set(t, c);
      H_.calls.push(c);
      S.signal = { call: c.call, confidence: c.confidence, p: c.p, hour, brain, ts, step: t };
      emit(c, live);

      const factor = th.call === "quiet" ? drip.quiet : drip.busy;
      const held = S.budget;
      const want = held * drip.share * factor;
      const cap = drip.capOfReserve * reserveEst;
      const spend = Math.min(want, cap, held);
      const burnedEst = spend > 0 ? (spend * drip.burnFactor) / close : 0;
      S.budget -= spend; S.spent += spend; S.burnedEst += burnedEst;
      if (spend > 0) S.buys++;
      if (want > cap) S.capped++;
      c.spend = spend; c.burnedEst = burnedEst;
      const dr = {
        type: "drip", step: t, ts, hour, call: th.call, added: S.hourAdded, held, share: drip.share, factor,
        want, cap, capped: want > cap, spend, price: close, burnedEst, burnIsEstimate: true, budget: S.budget,
      };
      S.hourAdded = 0;
      H_.drips.push(dr);
      emit(dr, live);
    }

    // once a day (from launch): the brain photo record
    if ((ts - t0) % 86400 === 0) {
      const hash = m.brainHash();
      const snap = { type: "snapshot", step: t, ts, day, hash, brain: hash.slice(0, 4), slot: null, weightsQ: m.weightsQ(), weights: m.weights() };
      H_.snapshots.push(snap);
      emit(snap, live);
    }

    H_.series.budget[t] = S.budget;
    H_.series.spent[t] = S.spent;
    H_.series.burned[t] = S.burnedEst;
    S.stats = makeStats(t, ts, hour, day);
    if (S.scored) H_.series.acc[t] = S.hits / S.scored;
    emit({ type: "stats", ...S.stats }, live);
    return true;
  }

  function makeStats(t, ts, hour, day) {
    const rn = S.recent.length, rh = S.recent.reduce((a, b) => a + b, 0);
    return {
      step: t, ts, hour, day, steps: n,
      calls: S.calls, scored: S.scored, hits: S.hits, acc: S.scored ? S.hits / S.scored : null,
      luck: luckBand(S.scored),
      rolling: { window: o.rollingWindow, n: rn, hits: rh, acc: rn ? rh / rn : null, luck: luckBand(rn) },
      naive: { busier: S.busier, quieter: S.quieter, acc: S.scored ? Math.max(S.busier, S.quieter) / S.scored : null },
      rule: { hits: S.ruleHits, acc: S.scored ? S.ruleHits / S.scored : null },
      budget: S.budget, added: S.added, spent: S.spent, burnedEst: S.burnedEst, burnIsEstimate: true,
      buys: S.buys, capped: S.capped,
      brain: S.model.brainId(), version: S.model.version, macs: S.model.macs,
    };
  }

  // ---------- playback ----------
  let playing = false, acc = 0, lastNow = 0, timer = null;
  const now = () => (globalThis.performance?.now?.() ?? Date.now());
  const raf = globalThis.requestAnimationFrame
    ? (fn) => globalThis.requestAnimationFrame(fn)
    : (fn) => setTimeout(() => fn(now()), 16);
  const caf = globalThis.cancelAnimationFrame ? (h) => globalThis.cancelAnimationFrame(h) : (h) => clearTimeout(h);

  function frame() {
    timer = null;
    if (!playing) return;
    const tNow = now();
    acc += ((tNow - lastNow) / 1000) * o.speed;
    lastNow = tNow;
    let k = Math.min(Math.floor(acc), o.maxStepsPerFrame);
    if (acc > o.maxStepsPerFrame) acc = o.maxStepsPerFrame; // do not pile up after a hidden tab
    while (k-- > 0) {
      acc -= 1;
      if (!advance(true)) {
        emit({ type: "end", step: S.i, stats: S.stats }, true);
        if (o.loop) { seek(o.startAt); continue; }
        playing = false; acc = 0;
        emit({ type: "pause", step: S.i }, true);
        return;
      }
    }
    timer = raf(frame);
  }

  function seek(step) {
    step = Math.max(0, Math.min(n, Math.floor(step)));
    if (step < S.i) reset();
    while (S.i < step) advance(false);
    emit({ type: "seek", step: S.i, stats: S.stats }, true);
  }

  const api = {
    data, source: data.source, label: REHEARSAL_LABEL, steps: n, t0,
    rules: drip, fee: FEE, chapters: CHAPTERS,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    play() {
      if (playing) return api;
      if (S.i >= n) { if (!o.loop) return api; seek(o.startAt); }
      playing = true; acc = 0; lastNow = now();
      emit({ type: "play", step: S.i }, true);
      timer = raf(frame);
      return api;
    },
    pause() {
      if (!playing) return api;
      playing = false;
      if (timer != null) { caf(timer); timer = null; }
      emit({ type: "pause", step: S.i }, true);
      return api;
    },
    toggle() { return playing ? api.pause() : api.play(); },
    setSpeed(sps) { o.speed = Math.max(0, +sps || 0); emit({ type: "speed", speed: o.speed }, true); return api; },
    step() { if (!advance(true)) emit({ type: "end", step: S.i, stats: S.stats }, true); return api; },
    seek(step) { seek(step); return api; },
    restart() { seek(0); return api; },
    runToEnd(live = false) { while (advance(live)); return S.stats; },
    get playing() { return playing; },
    get speed() { return o.speed; },
    get position() { return S.i; },              // steps done (next step index)
    get done() { return S.i >= n; },
    get model() { return S.model; },
    get stats() { return S.stats; },
    get signal() { return S.signal; },
    get history() { return S.history; },
    get budget() { return S.budget; },
    timeOf(step) { return t0 + step * stepSec; },
    hourOf(step) { return Math.floor((t0 + step * stepSec - hour0) / 3600); },
    reserveEstAt(step) { return reserveOf(Math.max(0, Math.min(n - 1, step))); },
  };

  reset();
  if (o.startAt > 0) while (S.i < Math.min(n, o.startAt)) advance(false);
  return api;
}

export { ONE };
