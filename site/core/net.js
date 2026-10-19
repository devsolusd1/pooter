// Hunch's network, version one, as integers: the reference the Solana program (programs/hunch-net)
// must match bit for bit (kill test K2).
//
// 10 inputs, 8 ReLU units, 8 more ReLU units, 1 sigmoid output: 169 weights in Q16.16 fixed point
// (integers, 1.0 = 65536). Predict-then-learn, one online gradient step per 10-minute bar.
// Chapters (sealed, dated in hours from the launch hour):
//   chapter 0 (hours 0-167)  inputs 9 and 10 zero and frozen, layer 2 a frozen identity: 81 numbers
//                            learn, and the network is exactly the simulated 8-8-1 (hunch/sim/sim.mjs);
//   chapter 1 (from day 7)   inputs 9 and 10 wake (from zero weights, so the call does not move): 97 learn;
//   chapter 2 (from day 14)  layer 2 wakes from the identity: all 169 learn;
//   chapter 3 (from day 21)  learning rate 2^-8 instead of 2^-7.
// No look-ahead: a bar's inputs use that bar and the ones before it; a sample is trained on only once
// the hour after it has been seen. Same integers on every machine, so nobody can steer it.
//
// Two ways in:
//   createNet()   the version-one model on integer bars { ts, retQ, lam, x9, x10 } (what the program
//                 measures: price return in Q16.16, outside volume in lamports), chapter passed in;
//   createModel() the chapter-0 view the site's rehearsal uses: feed({ ts, close, vol }) in SOL, the
//                 81 numbers of the 8-8-1 network in the old LAYOUT. It runs the same version-one
//                 code pinned to chapter 0.

import { sha256, toHex } from "./sha256.js";

export const ONE = 65536;           // 1.0 in Q16.16
export const BAR_SECONDS = 600;     // one bar = 10 minutes
export const H = 6;                 // bars per hour, also the outcome horizon
export const LR_SHIFT = 7;          // learning rate 2^-7 (chapters 0-2)
export const LR_SHIFT_SLOW = 8;     // learning rate 2^-8 (chapter 3)
export const SEED = 12346;          // the activity task's seed in sim.mjs (12345 + 1)
export const N_IN = 8;              // inputs the chapter-0 view shows
export const N_IN_V1 = 10;
export const N_BASE_IN = 8;
export const N_HID = 8;
export const N_WEIGHTS = 81;        // chapter-0 view: 64 + 8 + 8 + 1
export const N_WEIGHTS_V1 = 169;    // 80 + 8 + 64 + 8 + 8 + 1 = 13 x 13
export const WEIGHT_CLIP = 8 * ONE; // every weight stays in [-8, 8]
export const INPUT_CLIP = 4 * ONE;
export const FIRST_INPUT_BAR = 2 * H;
export const CHAPTER_HOURS = [7 * 24, 14 * 24, 21 * 24];

// Where each of the 81 chapter-0 numbers sits in the flat order used by weightsQ(), weights() and bytes().
export const LAYOUT = {
  W1: { offset: 0, count: 64, note: "input i -> hidden j at offset + j*8 + i" },
  b1: { offset: 64, count: 8, note: "hidden bias j" },
  W2: { offset: 72, count: 8, note: "hidden j -> output" },
  b2: { offset: 80, count: 1, note: "output bias" },
};
// The 169 numbers of version one, canonical order (what the program stores and hashes).
export const LAYOUT_V1 = {
  W1: { offset: 0, count: 80, note: "input i -> hidden j at offset + j*10 + i" },
  b1: { offset: 80, count: 8, note: "first hidden bias j" },
  W2: { offset: 88, count: 64, note: "first hidden j -> second hidden k at offset + k*8 + j" },
  b2: { offset: 152, count: 8, note: "second hidden bias k" },
  W3: { offset: 160, count: 8, note: "second hidden k -> output" },
  b3: { offset: 168, count: 1, note: "output bias" },
};

// The 8 inputs, in order. `label` is short for the page; `formula` is what the integer code does.
export const INPUTS = [
  { key: "move", label: "last move", formula: "10-min price move / typical move" },
  { key: "hourMove", label: "hour move", formula: "1-hour price move / (3 x typical move)" },
  { key: "barVol", label: "bar volume", formula: "(log2 bar volume - its average) / 4" },
  { key: "hourVol", label: "hour volume vs usual", formula: "(log2 hour volume - its slow average) / 2" },
  { key: "hourVolDelta", label: "hour volume vs hour before", formula: "(log2 hour volume - same 1 h earlier) / 2" },
  { key: "churn", label: "churn", formula: "sum of |moves| over the hour / (6 x typical move) - 1" },
  { key: "clockSin", label: "clock (sin)", formula: "sin(2 pi x UTC hour / 24)" },
  { key: "clockCos", label: "clock (cos)", formula: "cos(2 pi x UTC hour / 24)" },
];
// Version one adds two, read from chapter 1 (day 7) on.
export const INPUTS_V1 = [
  ...INPUTS,
  { key: "lastOutcome", label: "its last outcome", formula: "+1 hit, -1 miss or forfeit, 0 none" },
  { key: "hitRate", label: "its recent hit rate", formula: "hits / scored over the last 24 scored hours - 1/2" },
];

// ---------- fixed point helpers (what the Rust program does with i64) ----------
const fl = Math.floor;
export const mulQ = (a, b) => fl((a * b) / ONE);             // (a*b) >> 16, arithmetic shift
export const divQ = (a, b) => Math.trunc((a * ONE) / b);     // (a << 16) / b, truncating like Rust
export const toQ = (x) => Math.round(x * ONE);
export const fromQ = (q) => q / ONE;
const clip = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const shr = (v, s) => fl(v / 2 ** s);                          // arithmetic right shift
const rshr = (v, s) => fl((v + 2 ** (s - 1)) / 2 ** s);        // rounding right shift
const z = (v) => (Object.is(v, -0) ? 0 : v);

// integer log2 with a linear mantissa: msb + (u - 2^msb) / 2^msb, result Q16.16
export function log2q(u) {
  u = Math.floor(u);
  if (u < 1) return 0;
  let msb = 0;
  while (2 ** (msb + 1) <= u) msb++;
  const frac = Math.floor(((u - 2 ** msb) * ONE) / 2 ** msb);
  return msb * ONE + frac;
}

// Tables sealed as integers (the values sim.mjs computes with Math.sin, Math.cos and Math.exp),
// so no float library can make two machines disagree.
export const SIN = [0, 16962, 32768, 46341, 56756, 63303, 65536, 63303, 56756, 46341, 32768, 16962,
  0, -16962, -32768, -46341, -56756, -63303, -65536, -63303, -56756, -46341, -32768, -16962];
export const COS = [65536, 63303, 56756, 46341, 32768, 16962, 0, -16962, -32768, -46341, -56756, -63303,
  -65536, -63303, -56756, -46341, -32768, -16962, 0, 16962, 32768, 46341, 56756, 63303];
// sigmoid over [-8, 8] in steps of 0.5, linear interpolation between entries
export const SIG = [22, 36, 60, 98, 162, 267, 439, 720, 1179, 1921, 3108, 4971, 7812, 11955, 17625, 24743,
  32768, 40793, 47911, 53581, 57724, 60565, 62428, 63615, 64357, 64816, 65097, 65269, 65374, 65438, 65476, 65500, 65514];

export function sigQ(z) {
  if (z <= -8 * ONE) return SIG[0];
  if (z >= 8 * ONE) return SIG[32];
  const pos = z + 8 * ONE;              // 0 .. 16*ONE
  const k = fl(pos / (ONE / 2));        // segment
  const t = pos - k * (ONE / 2);        // 0 .. ONE/2
  return SIG[k] + fl(((SIG[k + 1] - SIG[k]) * t) / (ONE / 2));
}

// deterministic LCG for the initial weights
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ---------- chapters ----------
export function chapterOf(hoursSinceLaunch) {
  let c = 0;
  while (c < CHAPTER_HOURS.length && hoursSinceLaunch >= CHAPTER_HOURS[c]) c++;
  return c;
}
export const lrShiftOf = (chapter) => (chapter >= 3 ? LR_SHIFT_SLOW : LR_SHIFT);
export const learningCount = (chapter) => (chapter === 0 ? 81 : chapter === 1 ? 97 : 169);

// Serialise Q16.16 weights to bytes, little-endian i32 (81 -> 324 bytes, 169 -> 676 bytes).
export function weightsToBytes(q) {
  const out = new Uint8Array(q.length * 4);
  const v = new DataView(out.buffer);
  for (let i = 0; i < q.length; i++) v.setInt32(i * 4, q[i], true);
  return out;
}
export const hashWeights = (q) => toHex(sha256(weightsToBytes(q)));

export const callOf = (pQ) => (pQ >= ONE / 2 ? "busy" : "quiet");
export const confidenceOf = (pQ) => Math.max(pQ, ONE - pQ) / ONE;
// The lean toward busier in basis points, rounded half up (what the program stores).
export const leanBps = (pQ) => fl((pQ * 10000 + ONE / 2) / ONE);

// ---------- the 169 weights ----------
export class Weights {
  constructor() {
    this.w1 = Array.from({ length: N_HID }, () => new Array(N_IN_V1).fill(0));
    this.b1 = new Array(N_HID).fill(0);
    this.w2 = Array.from({ length: N_HID }, () => new Array(N_HID).fill(0));
    this.b2 = new Array(N_HID).fill(0);
    this.w3 = new Array(N_HID).fill(0);
    this.b3 = 0;
  }

  // 64 W1 numbers (inputs 1-8, row by row) then 8 W3 numbers from the LCG, as sim.mjs draws them;
  // inputs 9-10 zero, every bias zero, layer 2 the identity.
  static fromSeed(seed) {
    const w = new Weights();
    const r = lcg(seed);
    const sc = 0.35; // about 1/sqrt(8)
    for (let j = 0; j < N_HID; j++) for (let i = 0; i < N_BASE_IN; i++) w.w1[j][i] = toQ((r() * 2 - 1) * sc);
    for (let k = 0; k < N_HID; k++) w.w3[k] = toQ((r() * 2 - 1) * sc);
    for (let k = 0; k < N_HID; k++) w.w2[k][k] = ONE;
    return w;
  }

  static fromFlat(q) {
    if (q.length !== N_WEIGHTS_V1) throw new Error(`expected ${N_WEIGHTS_V1} weights`);
    const w = new Weights();
    let k = 0;
    for (let j = 0; j < N_HID; j++) for (let i = 0; i < N_IN_V1; i++) w.w1[j][i] = q[k++];
    for (let j = 0; j < N_HID; j++) w.b1[j] = q[k++];
    for (let a = 0; a < N_HID; a++) for (let j = 0; j < N_HID; j++) w.w2[a][j] = q[k++];
    for (let j = 0; j < N_HID; j++) w.b2[j] = q[k++];
    for (let j = 0; j < N_HID; j++) w.w3[j] = q[k++];
    w.b3 = q[k];
    return w;
  }

  frozenPartsAtLaunch() {
    for (let j = 0; j < N_HID; j++) {
      if (this.w1[j][8] !== 0 || this.w1[j][9] !== 0 || this.b2[j] !== 0) return false;
      for (let k = 0; k < N_HID; k++) if (this.w2[j][k] !== (j === k ? ONE : 0)) return false;
    }
    return true;
  }

  forward(x) {
    const z1 = new Array(N_HID), h1 = new Array(N_HID), z2 = new Array(N_HID), h2 = new Array(N_HID);
    for (let j = 0; j < N_HID; j++) {
      let acc = this.b1[j];
      for (let i = 0; i < N_IN_V1; i++) acc += mulQ(this.w1[j][i], x[i]);
      z1[j] = acc; h1[j] = acc > 0 ? acc : 0;
    }
    for (let k = 0; k < N_HID; k++) {
      let acc = this.b2[k];
      for (let j = 0; j < N_HID; j++) acc += mulQ(this.w2[k][j], h1[j]);
      z2[k] = acc; h2[k] = acc > 0 ? acc : 0;
    }
    let z3 = this.b3;
    for (let k = 0; k < N_HID; k++) z3 += mulQ(this.w3[k], h2[k]);
    return { z1, h1, z2, h2, z3, p: sigQ(z3) };
  }

  // One online gradient step on (x, y), y is 0 or ONE. Backward signals come from the old weights,
  // then every number the chapter lets learn moves; frozen parts are left alone.
  train(x, y, chapter) {
    const lr = lrShiftOf(chapter), W = WEIGHT_CLIP;
    const f = this.forward(x);
    const e = f.p - y;
    const d2 = new Array(N_HID).fill(0), d1 = new Array(N_HID).fill(0);
    for (let k = 0; k < N_HID; k++) if (f.z2[k] > 0) d2[k] = mulQ(e, this.w3[k]);
    for (let j = 0; j < N_HID; j++) {
      if (f.z1[j] > 0) { let acc = 0; for (let k = 0; k < N_HID; k++) acc += mulQ(d2[k], this.w2[k][j]); d1[j] = acc; }
    }
    const upd = (v, g) => clip(v - rshr(g, lr), -W, W);
    for (let k = 0; k < N_HID; k++) this.w3[k] = upd(this.w3[k], mulQ(e, f.h2[k]));
    this.b3 = upd(this.b3, e);
    if (chapter >= 2) {
      for (let k = 0; k < N_HID; k++) {
        if (d2[k] === 0) continue;
        for (let j = 0; j < N_HID; j++) this.w2[k][j] = upd(this.w2[k][j], mulQ(d2[k], f.h1[j]));
        this.b2[k] = upd(this.b2[k], d2[k]);
      }
    }
    const nIn = chapter >= 1 ? N_IN_V1 : N_BASE_IN;
    for (let j = 0; j < N_HID; j++) {
      if (d1[j] === 0) continue;
      for (let i = 0; i < nIn; i++) this.w1[j][i] = upd(this.w1[j][i], mulQ(d1[j], x[i]));
      this.b1[j] = upd(this.b1[j], d1[j]);
    }
    return { f, e, d1 };
  }

  flat() {
    const q = [];
    for (let j = 0; j < N_HID; j++) for (let i = 0; i < N_IN_V1; i++) q.push(z(this.w1[j][i]));
    for (let j = 0; j < N_HID; j++) q.push(z(this.b1[j]));
    for (let k = 0; k < N_HID; k++) for (let j = 0; j < N_HID; j++) q.push(z(this.w2[k][j]));
    for (let k = 0; k < N_HID; k++) q.push(z(this.b2[k]));
    for (let k = 0; k < N_HID; k++) q.push(z(this.w3[k]));
    q.push(z(this.b3));
    return q;
  }
  // the chapter-0 view: 81 numbers in the old 8-8-1 order
  flatV0() {
    const q = [];
    for (let j = 0; j < N_HID; j++) for (let i = 0; i < N_BASE_IN; i++) q.push(z(this.w1[j][i]));
    for (let j = 0; j < N_HID; j++) q.push(z(this.b1[j]));
    for (let k = 0; k < N_HID; k++) q.push(z(this.w3[k]));
    q.push(z(this.b3));
    return q;
  }
  bytes() { return weightsToBytes(this.flat()); }
  hash() { return hashWeights(this.flat()); }
}

// ---------- the version-one model: network + its own feature tape, on integer bars ----------
function push(arr, v, max) { arr.push(v); if (arr.length > max) arr.shift(); }

export class Net {
  constructor(seed = SEED) {
    this.seed = seed;
    this.weights = Weights.fromSeed(seed);
    this.version = 0;       // training steps so far
    this.t = -1;            // last bar fed (filled bars included)
    this.ts = null;
    this.s = 0; this.emaLv = 0; this.emaLvH = 0; this.started = false;
    this.chapter = 0;       // chapter of the last training step
    this.rHist = [];        // last 6 Q16.16 returns
    this.lamHist = [];      // last 6 bar volumes in lamports
    this.volHist = [];      // last 12 bar volumes in lamports (the outcome label)
    this.lvHHist = [];      // last 7 log2 hour volumes (to reach t - 6)
    this.xHist = [];        // last 7 input vectors or null (to reach t - 6)
  }

  // One bar: { ts (bar start, unix s), retQ (Q16.16 return before clipping), lam (outside volume in
  // lamports per 600 s), x9, x10 }. fill = true for a bar whose tick was missed: no move, no inputs.
  feed(bar, fill = false) {
    const t = ++this.t;
    this.ts = bar.ts;
    const r = t > 0 && !fill ? clip(bar.retQ, -ONE, INPUT_CLIP) : 0;
    const lam = bar.lam;
    push(this.rHist, r, H);
    push(this.volHist, lam, 2 * H);
    push(this.lamHist, lam, H);
    const lv = log2q(lam + 1);
    let hsum = 0;
    for (const v of this.lamHist) hsum += v;
    const lvH = log2q(hsum + 1);
    push(this.lvHHist, lvH, H + 1);
    const ar = Math.abs(r);
    if (!this.started) { this.s = Math.max(ar, 64); this.emaLv = lv; this.emaLvH = lvH; this.started = true; }
    else { this.s += shr(ar - this.s, 5); this.emaLv += shr(lv - this.emaLv, 4); this.emaLvH += shr(lvH - this.emaLvH, 6); }
    const sc = Math.max(this.s, 16);
    let x = null;
    if (t >= FIRST_INPUT_BAR && !fill) {
      let R6 = 0, A6 = 0;
      for (const v of this.rHist) { R6 += v; A6 += Math.abs(v); }
      const hour = Math.floor((((bar.ts % 86400) + 86400) % 86400) / 3600);
      const lvHPrev = this.lvHHist[0]; // lvH at t - 6
      const c = (v) => z(clip(v, -INPUT_CLIP, INPUT_CLIP));
      x = [
        c(divQ(r, sc)),
        c(divQ(R6, sc * 3)),
        c(shr(lv - this.emaLv, 2)),
        c(shr(lvH - this.emaLvH, 1)),
        c(shr(lvH - lvHPrev, 1)),
        c(divQ(A6, sc * 6) - ONE),
        SIN[hour], COS[hour],
        c(bar.x9 ?? 0), c(bar.x10 ?? 0),
      ];
    }
    push(this.xHist, x, H + 1);
    return x;
  }

  // The sample whose outcome became known with the last bar: the bar 6 back (u = t - 6).
  // Outcome: were the 6 bars after u busier (summed lamports) than the 6 bars ending at u?
  pending() {
    const t = this.t, u = t - H;
    if (u - H + 1 < 0) return null;
    const x = this.xHist.length === H + 1 ? this.xHist[0] : null;
    let next = 0, last = 0;
    for (let k = 0; k < H; k++) { last += this.volHist[k]; next += this.volHist[H + k]; }
    const y = next === last ? null : next > last ? 1 : 0;
    return { t: u, x, y, nextVol: next, lastVol: last };
  }

  learn(chapter) {
    const s = this.pending();
    if (!s || !s.x || s.y == null) return null;
    const r = this.weights.train(s.x, s.y ? ONE : 0, chapter);
    this.version++;
    this.chapter = chapter;
    return { sample: s.t, y: s.y, x: s.x, f: r.f, e: r.e, d1: r.d1 };
  }

  think() {
    const x = this.xHist.length ? this.xHist[this.xHist.length - 1] : null;
    return x ? { x, ...this.weights.forward(x) } : null;
  }

  step(bar, chapter) {
    const x = this.feed(bar, false);
    const learned = this.learn(chapter);
    const thought = this.think();
    return { t: this.t, x, learned, thought };
  }

  bytes() { return this.weights.bytes(); }
  brainHash() { return this.weights.hash(); }
}

export function createNet({ seed = SEED } = {}) {
  return new Net(seed);
}

// ---------- the chapter-0 view the site's rehearsal uses (8 inputs, 81 numbers) ----------
class Hunch {
  constructor(seed) {
    this.net = new Net(seed);
    this.seed = seed;
    this.lrShift = LR_SHIFT;
    this.macs = 0;        // multiply-accumulates of the 8-8-1 network so far (forward + training)
    this._hash = null;
    this._hashVersion = -1;
    this.prevClose = null;
    this.last = null;     // last think() result
  }

  get version() { return this.net.version; }
  get t() { return this.net.t; }
  get ts() { return this.net.ts; }

  forward(x8) {
    const f = this.net.weights.forward([...x8, 0, 0]);
    this.macs += 72;
    return { z1: f.z1, h: f.h1, z2: f.z3, p: f.p };
  }

  // feed one 10-minute bar: { ts (unix s), close (quote per token), vol (quote volume) }
  feed({ ts, close, vol }) {
    const t = this.net.t + 1;
    const retQ = t > 0 ? toQ(close / this.prevClose - 1) : 0;
    this.prevClose = close;
    const lam = Math.round(vol * 1e9);  // quote volume in base units, like a fee counter delta
    const x = this.net.feed({ ts, retQ, lam, x9: 0, x10: 0 }, false);
    return { t, x: x ? x.slice(0, N_BASE_IN) : null, move: this.net.rHist[this.net.rHist.length - 1] / ONE };
  }

  pending() {
    const s = this.net.pending();
    if (!s) return null;
    return {
      t: s.t, x: s.x ? s.x.slice(0, N_BASE_IN) : null, y: s.y,
      came: s.y == null ? null : s.y ? "busy" : "quiet", nextVol: s.nextVol / 1e9, lastVol: s.lastVol / 1e9,
    };
  }

  learn() {
    const before = this.weightsQ();
    const l = this.net.learn(0);
    if (!l) return null;
    const after = this.weightsQ();
    const changed = [];
    let maxAbs = 0;
    for (let i = 0; i < N_WEIGHTS; i++) {
      const d = after[i] - before[i];
      if (d !== 0) { changed.push([i, d / ONE]); if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d); }
    }
    let dead = 0, live = 0;
    for (const v of l.f.z1) if (v <= 0) dead++;
    for (const d of l.d1) if (d !== 0) live++;
    const macs = 72 + 2 * N_HID + N_BASE_IN * live;
    this.macs += macs;
    return {
      sample: l.sample, y: l.y ? "busy" : "quiet", p: l.f.p / ONE, error: l.e / ONE,
      changed, maxDelta: maxAbs / ONE, dead, macs, version: this.net.version,
    };
  }

  think() {
    const th = this.net.think();
    if (!th) { this.last = null; return null; }
    this.macs += 72;
    const x = th.x.slice(0, N_BASE_IN);
    this.last = {
      t: this.net.t, ts: this.net.ts, xQ: x, x: x.map(fromQ), z1: th.z1.map(fromQ), h: th.h1.map(fromQ),
      z2: th.z3 / ONE, pQ: th.p, p: th.p / ONE, call: callOf(th.p), confidence: confidenceOf(th.p),
      rule: x[3] < 0 ? "busy" : "quiet", // the one-line rule: busier if the last hour was below its usual level
    };
    return this.last;
  }

  step(bar) {
    const fed = this.feed(bar);
    const learned = this.learn();
    const thought = this.think();
    return { fed, learned, thought };
  }

  call() { return this.last ? { call: this.last.call, confidence: this.last.confidence, p: this.last.p } : null; }
  activations() { return this.last; }

  weightsQ() { return this.net.weights.flatV0(); }
  weights() { return this.weightsQ().map(fromQ); }
  bytes() { return weightsToBytes(this.weightsQ()); }
  brainHash() {
    if (this._hashVersion !== this.version) { this._hash = hashWeights(this.weightsQ()); this._hashVersion = this.version; }
    return this._hash;
  }
  brainId() { return this.brainHash().slice(0, 4); }
}

export function createModel({ seed = SEED } = {}) {
  return new Hunch(seed);
}
