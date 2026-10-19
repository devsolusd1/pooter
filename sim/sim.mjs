// Hunch off-chain simulation: 8-8-1 ReLU net, online SGD, Q16.16 fixed point, predict-then-learn.
// Usage: node sim.mjs [lrShift=7] [--json out.json]
import fs from 'node:fs';

const LR_SHIFT = Number(process.argv[2] || 7);
const JSON_OUT = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const NAMES = ['MONKEY', 'HAMSTER', 'FOMO', 'HOOKED', 'EMBER', 'JEANPHIL', 'swordcat', 'SLOPCORE'];
const BAR = 600;          // 10 minutes
const H = 6;              // bars per hour
const WARM = 150;         // bars before any call is scored (about one day)
const WINDOW_DAYS = 28;
const NOVOL = process.env.NOVOL === '1';

// ---------- fixed point helpers (what a Rust program would do with i64) ----------
const ONE = 65536;
const fl = Math.floor;
const mulQ = (a, b) => fl((a * b) / ONE);            // (a*b) >> 16, arithmetic shift
const divQ = (a, b) => Math.trunc((a * ONE) / b);    // (a << 16) / b, truncating like Rust
const clip = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const toQ = x => Math.round(x * ONE);
const shr = (v, s) => fl(v / 2 ** s);                // arithmetic right shift
const rshr = (v, s) => fl((v + 2 ** (s - 1)) / 2 ** s); // rounding right shift
// integer log2 with linear mantissa: msb + (u - 2^msb)/2^msb, result Q16.16
function log2q(u) {
  u = Math.floor(u);
  if (u < 1) return 0;
  let msb = 0; while (2 ** (msb + 1) <= u) msb++;
  const frac = Math.floor(((u - 2 ** msb) * ONE) / 2 ** msb);
  return msb * ONE + frac;
}
// 24-entry hour tables
const SIN = [], COS = [];
for (let h = 0; h < 24; h++) { SIN.push(toQ(Math.sin(2 * Math.PI * h / 24))); COS.push(toQ(Math.cos(2 * Math.PI * h / 24))); }
// sigmoid table over [-8, 8] step 0.5, linear interpolation
const SIG = []; for (let k = 0; k <= 32; k++) SIG.push(toQ(1 / (1 + Math.exp(-(k * 0.5 - 8)))));
function sigQ(z) {
  if (z <= -8 * ONE) return SIG[0];
  if (z >= 8 * ONE) return SIG[32];
  const pos = z + 8 * ONE;                  // 0 .. 16*ONE
  const k = fl(pos / (ONE / 2));            // segment
  const t = pos - k * (ONE / 2);            // 0 .. ONE/2
  return SIG[k] + fl(((SIG[k + 1] - SIG[k]) * t) / (ONE / 2));
}
let OPS = { mac: 0 };

// deterministic LCG for init
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// ---------- the network ----------
class NetQ {
  constructor(seed, lrShift) {
    const r = lcg(seed); this.lr = lrShift;
    const sc = 0.35; // about 1/sqrt(8)
    this.W1 = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => toQ((r() * 2 - 1) * sc)));
    this.b1 = new Array(8).fill(0);
    this.W2 = Array.from({ length: 8 }, () => toQ((r() * 2 - 1) * sc));
    this.b2 = 0;
  }
  forward(x) {
    const z1 = new Array(8), h = new Array(8);
    for (let j = 0; j < 8; j++) {
      let acc = this.b1[j];
      for (let i = 0; i < 8; i++) { acc += mulQ(this.W1[j][i], x[i]); OPS.mac++; }
      z1[j] = acc; h[j] = acc > 0 ? acc : 0;
    }
    let z2 = this.b2;
    for (let j = 0; j < 8; j++) { z2 += mulQ(this.W2[j], h[j]); OPS.mac++; }
    return { z1, h, z2, p: sigQ(z2) };
  }
  train(x, y) { // y is 0 or ONE
    const f = this.forward(x);
    const e = f.p - y;
    const W = 8 * ONE;
    for (let j = 0; j < 8; j++) {
      const d = f.z1[j] > 0 ? mulQ(e, this.W2[j]) : 0; OPS.mac++;
      this.W2[j] = clip(this.W2[j] - rshr(mulQ(e, f.h[j]), this.lr), -W, W); OPS.mac++;
      if (d !== 0) {
        for (let i = 0; i < 8; i++) { this.W1[j][i] = clip(this.W1[j][i] - rshr(mulQ(d, x[i]), this.lr), -W, W); OPS.mac++; }
        this.b1[j] = clip(this.b1[j] - rshr(d, this.lr), -W, W);
      }
    }
    this.b2 = clip(this.b2 - rshr(e, this.lr), -W, W);
  }
}
// float twin for fidelity check
class NetF {
  constructor(seed, lrShift) {
    const r = lcg(seed); this.lr = 2 ** -lrShift; const sc = 0.35;
    this.W1 = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => toQ((r() * 2 - 1) * sc) / ONE));
    this.b1 = new Array(8).fill(0);
    this.W2 = Array.from({ length: 8 }, () => toQ((r() * 2 - 1) * sc) / ONE);
    this.b2 = 0;
  }
  forward(x) {
    const z1 = [], h = [];
    for (let j = 0; j < 8; j++) { let a = this.b1[j]; for (let i = 0; i < 8; i++) a += this.W1[j][i] * x[i]; z1.push(a); h.push(Math.max(0, a)); }
    let z2 = this.b2; for (let j = 0; j < 8; j++) z2 += this.W2[j] * h[j];
    return { z1, h, z2, p: 1 / (1 + Math.exp(-z2)) };
  }
  train(x, y) {
    const f = this.forward(x); const e = f.p - y;
    for (let j = 0; j < 8; j++) {
      const d = f.z1[j] > 0 ? e * this.W2[j] : 0;
      this.W2[j] = clip(this.W2[j] - this.lr * e * f.h[j], -8, 8);
      for (let i = 0; i < 8; i++) this.W1[j][i] = clip(this.W1[j][i] - this.lr * d * x[i], -8, 8);
      this.b1[j] = clip(this.b1[j] - this.lr * d, -8, 8);
    }
    this.b2 = clip(this.b2 - this.lr * e, -8, 8);
  }
}

// ---------- data ----------
function loadPool(name, endTs) {
  const j = JSON.parse(fs.readFileSync(`data/ohlcv_${name}.json`, 'utf8'));
  const rows = j.rows;
  if (!rows.length) return null;
  const start = Math.max(Math.floor(rows[0][0] / BAR) * BAR, Math.floor((endTs - WINDOW_DAYS * 86400) / BAR) * BAR);
  const nb = Math.floor((endTs - start) / BAR) + 1;
  const close = new Array(nb).fill(null), vol = new Array(nb).fill(0), trades = new Array(nb).fill(false);
  let lastBeforeStart = null;
  for (const [ts, o, h, l, c, v] of rows) {
    const b = Math.floor((ts - start) / BAR);
    if (b < 0) { lastBeforeStart = c; continue; }
    if (b >= nb) continue;
    close[b] = c; vol[b] += v; trades[b] = true; // rows sorted ascending, so later 5-min close wins
  }
  let last = lastBeforeStart ?? rows.find(r => r[0] >= start)?.[1];
  for (let b = 0; b < nb; b++) { if (close[b] == null) close[b] = last; last = close[b]; }
  const ts = Array.from({ length: nb }, (_, b) => start + b * BAR);
  return { name, dex: j.dex, addr: j.addr, ts, close, vol, trades, nb, firstTs: rows[0][0], lastTs: rows.at(-1)[0], rawRows: rows.length };
}

// ---------- features, all integer ----------
function buildFeatures(P) {
  const n = P.nb; const X = new Array(n).fill(null);
  const r = new Array(n).fill(0);                // Q16.16 simple return per bar
  const lv = new Array(n).fill(0), lvH = new Array(n).fill(0), Hs = new Array(n).fill(0);
  let s = 0, emaLv = 0, emaLvH = 0, init = false;
  const SC = new Array(n).fill(0), EL = new Array(n).fill(0), ELH = new Array(n).fill(0), R6a = new Array(n).fill(0), A6a = new Array(n).fill(0), LAM = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    if (t > 0) r[t] = clip(toQ(P.close[t] / P.close[t - 1] - 1), -ONE, 4 * ONE);
    const lam = Math.round(P.vol[t] * 1e9);      // quote volume in base units, like a fee counter delta
    lv[t] = log2q(lam + 1);
    let hsum = 0; for (let k = 0; k < H && t - k >= 0; k++) hsum += Math.round(P.vol[t - k] * 1e9);
    Hs[t] = hsum; lvH[t] = log2q(hsum + 1);
    const ar = Math.abs(r[t]);
    if (!init) { s = Math.max(ar, 64); emaLv = lv[t]; emaLvH = lvH[t]; init = true; }
    else { s += shr(ar - s, 5); emaLv += shr(lv[t] - emaLv, 4); emaLvH += shr(lvH[t] - emaLvH, 6); }
    const sc = Math.max(s, 16);
    SC[t] = sc; EL[t] = emaLv; ELH[t] = emaLvH; LAM[t] = lam;
    if (t < 2 * H) continue;
    let R6 = 0, A6 = 0; for (let k = 0; k < H; k++) { R6 += r[t - k]; A6 += Math.abs(r[t - k]); }
    R6a[t] = R6; A6a[t] = A6;
    const hour = new Date(P.ts[t] * 1000).getUTCHours();
    X[t] = [
      clip(divQ(r[t], sc), -4 * ONE, 4 * ONE),
      clip(divQ(R6, sc * 3), -4 * ONE, 4 * ONE),
      clip(shr(lv[t] - emaLv, 2), -4 * ONE, 4 * ONE),
      clip(shr(lvH[t] - emaLvH, 1), -4 * ONE, 4 * ONE),
      clip(shr(lvH[t] - lvH[t - H], 1), -4 * ONE, 4 * ONE),
      clip(divQ(A6, sc * 6) - ONE, -4 * ONE, 4 * ONE),
      SIN[hour], COS[hour],
    ];
    if (NOVOL) { X[t][2] = 0; X[t][3] = 0; X[t][4] = 0; }
  }
  return { X, r, lv, lvH, Hs, SC, EL, ELH, R6a, A6a, LAM };
}
// inputs as they would be if someone pushed the last bar's price by dr (a fraction, e.g. -0.05)
function pushPrice(F, t, dr) {
  const x = F.X[t].slice(), sc = F.SC[t], d = toQ(dr), r1 = F.r[t] + d;
  x[0] = clip(divQ(r1, sc), -4 * ONE, 4 * ONE);
  x[1] = clip(divQ(F.R6a[t] + d, sc * 3), -4 * ONE, 4 * ONE);
  x[5] = clip(divQ(F.A6a[t] - Math.abs(F.r[t]) + Math.abs(r1), sc * 6) - ONE, -4 * ONE, 4 * ONE);
  return x;
}
// inputs as they would be if someone wash-traded an extra hour's worth of volume into the last bar
function pushVolume(F, t) {
  const x = F.X[t].slice(); const extra = F.Hs[t];
  const lv1 = log2q(F.LAM[t] + extra + 1), lvH1 = log2q(F.Hs[t] + extra + 1);
  x[2] = clip(shr(lv1 - F.EL[t], 2), -4 * ONE, 4 * ONE);
  x[3] = clip(shr(lvH1 - F.ELH[t], 1), -4 * ONE, 4 * ONE);
  x[4] = clip(shr(lvH1 - F.lvH[t - H], 1), -4 * ONE, 4 * ONE);
  return x;
}

// ---------- labels ----------
function labels(P, F) {
  const n = P.nb; const c = P.close;
  const dir = new Array(n).fill(null), act = new Array(n).fill(null), big = new Array(n).fill(null);
  const absH = new Array(n).fill(null); // |1h return| ending at t
  for (let t = H; t < n; t++) absH[t] = Math.abs(Math.log(c[t] / c[t - H]));
  for (let t = 0; t < n; t++) {
    if (t + 1 < n && c[t + 1] !== c[t]) dir[t] = c[t + 1] > c[t] ? 1 : 0;
    if (t + H < n && t - H + 1 >= 0) {
      let nx = 0, ls = 0; for (let k = 1; k <= H; k++) nx += P.vol[t + k]; for (let k = 0; k < H; k++) ls += P.vol[t - k];
      if (nx !== ls) act[t] = nx > ls ? 1 : 0;
    }
    if (t + H < n && t >= 24 * H) {
      const past = []; for (let k = 0; k < 24; k++) past.push(absH[t - k * H]); past.sort((a, b) => a - b);
      const med = (past[11] + past[12]) / 2;
      const fut = Math.abs(Math.log(c[t + H] / c[t]));
      if (!(fut === 0 && med === 0)) big[t] = fut > med ? 1 : 0;
    }
  }
  return { dir, act, big, absH };
}

// ---------- run one task ----------
function runTask(P, F, Y, horizon, seed, lrShift, perturb = []) {
  const net = new NetQ(seed, lrShift), twin = new NetF(seed, lrShift);
  const calls = new Array(P.nb).fill(null), probs = new Array(P.nb).fill(null);
  const pcalls = perturb.map(() => new Array(P.nb).fill(null));
  let agree = 0, both = 0;
  for (let t = 0; t < P.nb; t++) {
    // learn from the sample whose outcome just became known
    const u = t - horizon;
    if (u >= 0 && F.X[u] && Y[u] != null) {
      net.train(F.X[u], Y[u] ? ONE : 0);
      twin.train(F.X[u].map(v => v / ONE), Y[u]);
    }
    if (F.X[t]) {
      const p = net.forward(F.X[t]).p; calls[t] = p >= ONE / 2 ? 1 : 0; probs[t] = p / ONE;
      const save = OPS.mac; perturb.forEach((fn, k) => { pcalls[k][t] = net.forward(fn(F, t)).p >= ONE / 2 ? 1 : 0; }); OPS.mac = save;
      const pf = twin.forward(F.X[t].map(v => v / ONE)).p;
      if (t >= WARM) { both++; if ((pf >= 0.5 ? 1 : 0) === calls[t]) agree++; }
    }
  }
  return { calls, probs, agree, both, net, pcalls };
}

function score(calls, Y, P, from, step) {
  let n = 0, ok = 0, ones = 0;
  for (let t = from; t < P.nb; t += step) {
    if (calls[t] == null || Y[t] == null) continue;
    n++; if (calls[t] === Y[t]) ok++; if (Y[t] === 1) ones++;
  }
  return { n, ok, ones };
}
function scoreRule(ruleFn, Y, P, from, step) {
  let n = 0, ok = 0;
  for (let t = from; t < P.nb; t += step) {
    if (Y[t] == null) continue; const g = ruleFn(t); if (g == null) continue;
    n++; if (g === Y[t]) ok++;
  }
  return { n, ok };
}

// ---------- main ----------
const pools = [];
let endTs = 0;
for (const nm of NAMES) { try { const j = JSON.parse(fs.readFileSync(`data/ohlcv_${nm}.json`)); if (j.rows.length) endTs = Math.max(endTs, j.rows.at(-1)[0]); } catch {} }
endTs = Math.floor(endTs / BAR) * BAR;
const out = { lrShift: LR_SHIFT, endTs: new Date(endTs * 1000).toISOString(), pools: [] };
const agg = {};
for (const nm of NAMES) {
  if (!fs.existsSync(`data/ohlcv_${nm}.json`)) continue;
  const P = loadPool(nm, endTs); if (!P) continue;
  const F = buildFeatures(P); const L = labels(P, F);
  const tradeBars = P.trades.filter(Boolean).length;
  const rec = { name: nm, dex: P.dex, addr: P.addr, from: new Date(P.ts[0] * 1000).toISOString(), to: new Date(P.ts.at(-1) * 1000).toISOString(),
    days: +(P.nb / 144).toFixed(1), bars: P.nb, barsWithTrades: tradeBars, raw5m: P.rawRows,
    volQuoteTotal: +P.vol.reduce((a, b) => a + b, 0).toFixed(2), tasks: {} };
  // baselines
  const c = P.close;
  const lastMoveSign = new Array(P.nb).fill(null); { let s = null; for (let t = 1; t < P.nb; t++) { if (c[t] !== c[t - 1]) s = c[t] > c[t - 1] ? 1 : 0; lastMoveSign[t] = s; } }
  const tasks = {
    direction: { Y: L.dir, h: 1, step: 1, perturb: [(F, t) => pushPrice(F, t, -0.05), (F, t) => pushPrice(F, t, 0.05)], rules: {
      persistence: t => lastMoveSign[t], reversal: t => lastMoveSign[t] == null ? null : 1 - lastMoveSign[t] } },
    activity: { Y: L.act, h: H, step: H, perturb: [(F, t) => pushVolume(F, t), (F, t) => pushPrice(F, t, -0.05)], rules: {
      persistence: t => (F.lvH[t] === F.lvH[t - H] ? null : (F.lvH[t] > F.lvH[t - H] ? 1 : 0)),
      reversal: t => (F.lvH[t] === F.lvH[t - H] ? null : (F.lvH[t] > F.lvH[t - H] ? 0 : 1)),
      belowLevel: t => (F.X[t] ? (F.X[t][3] < 0 ? 1 : 0) : null) } },
    bigmove: { Y: L.big, h: H, step: H, rules: {
      persistence: t => { if (t < 24 * H) return null; const past = []; for (let k = 0; k < 24; k++) past.push(L.absH[t - k * H]); past.sort((a, b) => a - b); const med = (past[11] + past[12]) / 2; return L.absH[t] > med ? 1 : 0; } } },
  };
  let seed = 12345;
  for (const [tn, T] of Object.entries(tasks)) {
    const R = runTask(P, F, T.Y, T.h, seed++, LR_SHIFT, T.perturb || []);
    rec['_pcalls_' + tn] = R.pcalls;
    // align hourly scoring on the UTC hour grid
    let from = WARM; while (T.step > 1 && (P.ts[from] % 3600) !== 0) from++;
    const s = score(R.calls, T.Y, P, from, T.step);
    const sAll = score(R.calls, T.Y, P, WARM, 1);
    const mid = from + Math.floor((P.nb - from) / (2 * T.step)) * T.step;
    const s1 = score(R.calls.map((v, i) => (i < mid ? v : null)), T.Y, P, from, T.step), s2 = score(R.calls, T.Y, P, mid, T.step);
    const base = s.n ? Math.max(s.ones, s.n - s.ones) / s.n : null;
    const rules = {}; for (const [rn, fn] of Object.entries(T.rules)) { const q = scoreRule(fn, T.Y, P, from, T.step); rules[rn] = { n: q.n, acc: q.n ? +(q.ok / q.n).toFixed(4) : null }; }
    const band = s.n ? 1.96 * Math.sqrt(0.25 / s.n) : null;
    rec.tasks[tn] = { n: s.n, acc: s.n ? +(s.ok / s.n).toFixed(4) : null, accAllBars: sAll.n ? +(sAll.ok / sAll.n).toFixed(4) : null, nAllBars: sAll.n,
      upShare: s.n ? +(s.ones / s.n).toFixed(4) : null, majority: base ? +base.toFixed(4) : null, rules, band: band ? +band.toFixed(4) : null,
      fixedFloatAgree: R.both ? +(R.agree / R.both).toFixed(4) : null,
      firstHalf: s1.n ? +(s1.ok / s1.n).toFixed(4) : null, secondHalf: s2.n ? +(s2.ok / s2.n).toFixed(4) : null };
    rec['_calls_' + tn] = R.calls; rec['_probs_' + tn] = R.probs;
    const A = (agg[tn] ??= { n: 0, ok: 0, maj: 0, rules: {} });
    A.n += s.n; A.ok += s.ok; A.maj += Math.max(s.ones, s.n - s.ones);
    for (const [rn, q] of Object.entries(rules)) { const B = (A.rules[rn] ??= { n: 0, ok: 0 }); B.n += q.n; B.ok += Math.round((q.acc || 0) * q.n); }
  }
  rec._P = P; rec._F = F; rec._L = L;
  out.pools.push(rec);
}
out.aggregateExMonkey = {};
// aggregate excluding MONKEY (MONKEY reported alone)
for (const tn of ['direction', 'activity', 'bigmove']) {
  let n = 0, ok = 0, maj = 0; const rules = {};
  for (const p of out.pools) { if (p.name === 'MONKEY') continue; const t = p.tasks[tn]; if (!t.n) continue; n += t.n; ok += Math.round(t.acc * t.n); maj += Math.round(t.majority * t.n);
    for (const [rn, q] of Object.entries(t.rules)) { const B = (rules[rn] ??= { n: 0, ok: 0 }); B.n += q.n; B.ok += Math.round((q.acc || 0) * q.n); } }
  out.aggregateExMonkey[tn] = { n, acc: +(ok / n).toFixed(4), majority: +(maj / n).toFixed(4), band: +(1.96 * Math.sqrt(0.25 / n)).toFixed(4),
    rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, +(v.ok / v.n).toFixed(4)])) };
}

// ---------- buyback rules ----------
function buyback(rec) {
  const P = rec._P, F = rec._F; const c = P.close, n = P.nb;
  const dirCalls = rec._calls_direction, actCalls = rec._calls_activity;
  const rules = {
    even: { B: 0, spent: 0, tok: 0, buys: [] },
    modelDown: { B: 0, spent: 0, tok: 0, buys: [] },
    quietMore: { B: 0, spent: 0, tok: 0, buys: [] },
    afterDrop: { B: 0, spent: 0, tok: 0, buys: [] },
    drip: { B: 0, spent: 0, tok: 0, buys: [] },          // each hour spend 1/6 of what is held
    dripQuiet: { B: 0, spent: 0, tok: 0, buys: [] },     // drip x1.5 if the activity model calls a quiet hour, x0.5 if busy
    dripDrop: { B: 0, spent: 0, tok: 0, buys: [] },      // drip x2 after a sharp drop, x0.75 otherwise
  };
  let accrued = 0; let twapSum = 0, twapN = 0, vwN = 0, vwD = 0;
  let lastHourAccrual = 0, hourAcc = 0;
  const absHpast = [];
  const manip = { modelDown: { pts: 0, flip: 0 }, quietMore: { pts: 0, flip: 0 }, afterDrop: { pts: 0, flip: 0 } };
  for (let t = WARM; t < n; t++) {
    const add = 0.01 * P.vol[t]; accrued += add; hourAcc += add;
    for (const R of Object.values(rules)) R.B += add;
    twapSum += c[t]; twapN++; vwN += P.vol[t]; vwD += c[t] > 0 ? P.vol[t] / c[t] : 0;
    const buy = (R, amt, tag) => { amt = Math.min(amt, R.B); if (amt <= 0) return; R.B -= amt; R.spent += amt; R.tok += amt / c[t]; R.buys.push({ t, amt, p: c[t] }); };
    const onHour = P.ts[t] % 3600 === 0;
    const R6 = Math.log(c[t] / c[t - H]);
    // (ii) model predicts down -> spend everything held
    if (dirCalls[t] === 0) buy(rules.modelDown, rules.modelDown.B);
    else if (dirCalls[t] === 1) { manip.modelDown.pts++; if (rec._pcalls_direction[0][t] === 0 || rec._pcalls_direction[1][t] === 0) manip.modelDown.flip++; }
    // (iv) sharp drop: last hour's return below -2 x median |1h return| over the last 24 h
    let med = null;
    if (absHpast.length >= 24) { const s = absHpast.slice(-24).sort((a, b) => a - b); med = (s[11] + s[12]) / 2; }
    const sharp = med != null && R6 < -Math.max(2 * med, 0.02);
    if (sharp) buy(rules.afterDrop, rules.afterDrop.B);
    else if (med != null) { manip.afterDrop.pts++; if (R6 + Math.log(0.95) < -Math.max(2 * med, 0.02)) manip.afterDrop.flip++; }
    if (onHour) {
      lastHourAccrual = hourAcc; hourAcc = 0;
      buy(rules.even, rules.even.B); // (i)
      // (iii) predicted quiet hour -> spend all held, else spend half the hour's accrual
      if (actCalls[t] === 0) buy(rules.quietMore, rules.quietMore.B); else { buy(rules.quietMore, 0.5 * lastHourAccrual);
        if (actCalls[t] === 1) { manip.quietMore.pts++; if (rec._pcalls_activity[0][t] === 0 || rec._pcalls_activity[1][t] === 0) manip.quietMore.flip++; } }
      if (!sharp) buy(rules.afterDrop, 0.5 * lastHourAccrual);
      buy(rules.drip, rules.drip.B / 6);
      buy(rules.dripQuiet, rules.dripQuiet.B / 6 * (actCalls[t] === 0 ? 1.5 : 0.5));
      buy(rules.dripDrop, rules.dripDrop.B / 6 * (sharp ? 2 : 0.75));
      absHpast.push(Math.abs(R6));
    }
  }
  // further drop after a buy: price one hour later below the buy price (weighted by amount)
  const res = { vwap: vwN / vwD, twap: twapSum / twapN, accrued };
  let baseDropW = 0, baseDropN = 0; for (let t = WARM; t + H < n; t++) { baseDropN++; if (c[t + H] < c[t]) baseDropW++; }
  res.unconditionalDrop1h = baseDropW / baseDropN;
  for (const [k, R] of Object.entries(rules)) {
    if (R.B > 0) { R.spentEnd = R.B; }
    let wd = 0, w = 0, wd10 = 0, maxBuy = 0;
    for (const b of R.buys) { if (b.t + H < n) { w += b.amt; if (c[b.t + H] < b.p) wd += b.amt; if (c[b.t + 1] < b.p) wd10 += b.amt; } maxBuy = Math.max(maxBuy, b.amt); }
    const avg = R.tok > 0 ? R.spent / R.tok : null;
    res[k] = { buys: R.buys.length, spentShare: +(R.spent / accrued).toFixed(4), avgBuyVsVWAP: avg ? +(avg / res.vwap - 1).toFixed(4) : null, avgBuyVsTWAP: avg ? +(avg / res.twap - 1).toFixed(4) : null,
      avgBuy: avg, dropAfter1h: w ? +(wd / w).toFixed(4) : null, dropAfter10m: w ? +(wd10 / w).toFixed(4) : null, maxBuy: +maxBuy.toFixed(4),
      maxBuyHours: +(maxBuy / (accrued / ((n - WARM) / H))).toFixed(2) };
  }
  for (const k of ['modelDown', 'quietMore', 'afterDrop']) res[k].pushFlipsToBuy = manip[k].pts ? +(manip[k].flip / manip[k].pts).toFixed(4) : null;
  for (const k of ['modelDown', 'quietMore', 'afterDrop', 'drip', 'dripQuiet', 'dripDrop']) res[k].avgBuyVsEven = res[k].avgBuy && res.even.avgBuy ? +(res[k].avgBuy / res.even.avgBuy - 1).toFixed(4) : null;
  return res;
}
for (const rec of out.pools) {
  if (rec.name === 'MONKEY') { rec.buyback = null; continue; }
  rec.buyback = buyback(rec);
}
// strip internals
for (const rec of out.pools) for (const k of Object.keys(rec)) if (k.startsWith('_')) delete rec[k];
out.opsTotalMac = OPS.mac;
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
